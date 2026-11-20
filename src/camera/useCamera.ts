import { onScopeDispose, ref, type Ref } from 'vue';
import { describeCameraError, preflightCameraError, type CameraErrorInfo } from './cameraErrors';
import { frameFromVideo, type Frame } from './frame';

/**
 * Owns the MediaStream lifecycle. Deliberately small and imperative: the
 * component decides when the camera opens (an explicit button press), this
 * composable guarantees the tracks are stopped on close and on unmount.
 *
 * Only video is ever requested; `audio: false` is always sent.
 */

export type CameraStatus = 'idle' | 'starting' | 'live' | 'error';

export interface VideoInput {
  deviceId: string;
  label: string;
}

export interface UseCameraApi {
  status: Ref<CameraStatus>;
  error: Ref<CameraErrorInfo | null>;
  inputs: Ref<VideoInput[]>;
  activeDeviceId: Ref<string | null>;
  open: (deviceId?: string) => Promise<void>;
  stop: () => void;
  capture: () => Promise<Frame>;
  refreshInputs: () => Promise<void>;
  clearError: () => void;
}

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
};

export function useCamera(videoRef: Ref<HTMLVideoElement | null>): UseCameraApi {
  const status = ref<CameraStatus>('idle');
  const error = ref<CameraErrorInfo | null>(null);
  const inputs = ref<VideoInput[]>([]);
  const activeDeviceId = ref<string | null>(null);

  let stream: MediaStream | null = null;
  let endingTrack: MediaStreamTrack | null = null;

  function stopTracks(): void {
    if (endingTrack) {
      endingTrack.removeEventListener('ended', onTrackEnded);
      endingTrack = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    const el = videoRef.value;
    if (el) el.srcObject = null;
  }

  function onTrackEnded(): void {
    stopTracks();
    status.value = 'error';
    error.value = describeCameraError({ name: 'NotReadableError' });
  }

  function stop(): void {
    stopTracks();
    if (status.value !== 'error') status.value = 'idle';
    activeDeviceId.value = null;
  }

  function clearError(): void {
    error.value = null;
    if (status.value === 'error') status.value = 'idle';
  }

  async function refreshInputs(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      inputs.value = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    } catch {
      // Enumeration is best-effort; a failure here must not block the camera.
      inputs.value = [];
    }
  }

  async function open(deviceId?: string): Promise<void> {
    error.value = null;

    const preflight = preflightCameraError({
      isSecureContext: typeof window !== 'undefined' && window.isSecureContext === true,
      hasMediaDevices:
        typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function',
    });
    if (preflight) {
      stopTracks();
      error.value = preflight;
      status.value = 'error';
      return;
    }

    stopTracks();
    status.value = 'starting';

    const video: MediaTrackConstraints = deviceId
      ? { ...VIDEO_CONSTRAINTS, deviceId: { exact: deviceId } }
      : { ...VIDEO_CONSTRAINTS, facingMode: { ideal: 'environment' } };

    try {
      const next = await navigator.mediaDevices.getUserMedia({ audio: false, video });
      stream = next;

      const el = videoRef.value;
      if (!el) {
        stopTracks();
        error.value = describeCameraError({ name: 'AbortError' });
        status.value = 'error';
        return;
      }

      el.srcObject = next;
      try {
        await el.play();
      } catch (playError) {
        // Rapid device switching can abort a pending play(); that is not a real failure.
        const name = (playError as { name?: string } | null)?.name;
        if (name !== 'AbortError') throw playError;
      }

      const track = next.getVideoTracks()[0] ?? null;
      if (track) {
        endingTrack = track;
        track.addEventListener('ended', onTrackEnded);
        activeDeviceId.value = track.getSettings().deviceId ?? deviceId ?? null;
      } else {
        activeDeviceId.value = deviceId ?? null;
      }

      status.value = 'live';
      void refreshInputs();
    } catch (err) {
      stopTracks();
      error.value = describeCameraError(err);
      status.value = 'error';
    }
  }

  async function capture(): Promise<Frame> {
    const el = videoRef.value;
    if (!el || status.value !== 'live') {
      throw new Error('The camera is not running.');
    }
    return frameFromVideo(el);
  }

  onScopeDispose(stop);

  return {
    status,
    error,
    inputs,
    activeDeviceId,
    open,
    stop,
    capture,
    refreshInputs,
    clearError,
  };
}
