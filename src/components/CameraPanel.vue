<script setup lang="ts">
import { computed, ref } from 'vue';
import { describeCameraError, type CameraErrorInfo } from '../camera/cameraErrors';
import { frameFromFile, type Frame } from '../camera/frame';
import { useCamera } from '../camera/useCamera';

/**
 * Camera acquisition and the photo-upload fallback.
 *
 * The camera is only ever opened from an explicit button press, and the stream
 * is stopped as soon as a frame is frozen. Only video is requested:
 * `useCamera` always sends `audio: false`.
 */

const emit = defineEmits<{ captured: [frame: Frame] }>();

const videoRef = ref<HTMLVideoElement | null>(null);
const camera = useCamera(videoRef);

const busy = ref(false);
const captureError = ref<CameraErrorInfo | null>(null);
const uploadError = ref<string | null>(null);
const showPreview = ref(false);

const status = camera.status;
const isLive = computed(() => status.value === 'live');
const isStarting = computed(() => status.value === 'starting');
const errorInfo = computed<CameraErrorInfo | null>(() => camera.error.value ?? captureError.value ?? null);

async function openCamera(deviceId?: string): Promise<void> {
  captureError.value = null;
  uploadError.value = null;
  showPreview.value = true;
  await camera.open(deviceId);
}

function closeCamera(): void {
  camera.stop();
  showPreview.value = false;
}

async function capture(): Promise<void> {
  busy.value = true;
  captureError.value = null;
  try {
    const frame = await camera.capture();
    // The frame is frozen; the live stream is no longer needed.
    closeCamera();
    emit('captured', frame);
  } catch (err) {
    captureError.value = describeCameraError(err);
  } finally {
    busy.value = false;
  }
}

function onDeviceChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  if (value && value !== camera.activeDeviceId.value) void openCamera(value);
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  if (!file) return;

  busy.value = true;
  uploadError.value = null;
  try {
    emit('captured', await frameFromFile(file));
  } catch (err) {
    uploadError.value = err instanceof Error ? err.message : 'The photo could not be read.';
  } finally {
    busy.value = false;
    // Allow re-picking the same file.
    input.value = '';
  }
}
</script>

<template>
  <div class="stack">
    <p class="muted">
      Open the camera and capture a still, or upload a photo you already have. A frozen still is used for
      everything after this point.
    </p>

    <div class="row">
      <button class="primary grow" :disabled="isStarting || busy" @click="openCamera()">
        {{ isLive ? 'Restart camera' : 'Open rear camera' }}
      </button>
      <button v-if="showPreview || isLive" class="ghost" @click="closeCamera">Close camera</button>
    </div>

    <video
      v-show="showPreview"
      ref="videoRef"
      class="preview"
      playsinline
      autoplay
      muted
      aria-label="Live camera preview"
    ></video>

    <div v-if="isLive && camera.inputs.value.length > 1" class="stack">
      <label class="muted" for="camera-device">Camera</label>
      <select id="camera-device" :value="camera.activeDeviceId.value ?? ''" @change="onDeviceChange">
        <option v-for="input in camera.inputs.value" :key="input.deviceId" :value="input.deviceId">
          {{ input.label }}
        </option>
      </select>
    </div>

    <button :disabled="!isLive || busy" @click="capture">Capture and freeze frame</button>

    <hr />

    <div class="stack">
      <label class="muted" for="photo-input">Or choose a photo from this device</label>
      <input
        id="photo-input"
        type="file"
        accept="image/*"
        :disabled="busy"
        @change="onFileChange"
      />
    </div>

    <div v-if="errorInfo" class="notice notice--error">
      <strong>{{ errorInfo.title }}</strong>
      <p>{{ errorInfo.detail }}</p>
      <p v-if="errorInfo.suggestUpload" class="muted">
        You can carry on without a camera: pick a photo with the file input above.
      </p>
    </div>

    <div v-if="uploadError" class="notice notice--error">
      <strong>Could not read that photo</strong>
      <p>{{ uploadError }}</p>
    </div>

    <details>
      <summary>Camera troubleshooting on a phone</summary>
      <ul>
        <li>
          Camera access needs a secure context. That means <code>https://</code> or
          <code>http://localhost</code>.
        </li>
        <li>
          Opening the dev server from your phone by your laptop's LAN IP over plain
          <code>http://</code> will not give you camera access. It is not a bug in this app.
        </li>
        <li>
          Testing the camera on a real phone therefore needs an HTTPS origin: a static host for the
          built <code>dist/</code> folder, or an HTTPS tunnel. Ask before setting either of those up.
        </li>
        <li>
          The photo-upload path works over plain HTTP, so the whole scoring flow can be tested
          without HTTPS.
        </li>
        <li>On iOS, camera permission can only be requested after a tap - that is why there is a button.</li>
        <li>If the camera is busy, close other apps or browser tabs that may be using it.</li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.preview {
  max-height: 45vh;
  object-fit: contain;
}

hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 4px 0;
}
</style>
