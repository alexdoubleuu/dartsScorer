<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import CalibrationSchematic from './components/CalibrationSchematic.vue';
import CameraPanel from './components/CameraPanel.vue';
import ImageTapper from './components/ImageTapper.vue';
import ScorePanel from './components/ScorePanel.vue';
import { releaseFrame, type Frame } from './camera/frame';
import { hasAutomatedDetector } from './detector/Detector';
import {
  CALIBRATION_POINT_COUNT,
  CALIBRATION_REFS,
  buildCalibration,
  calibratedBoardRadius,
  type Calibration,
} from './geometry/calibration';
import { scoreImagePoint, type DartEntry, type MarkedDart } from './scoring/score';
import type { Point, Size, TapperMarker } from './types';

/**
 * MANUAL POINT-TO-SCORE PROTOTYPE
 *
 * This milestone is manual by design. The user taps the four calibration wires,
 * then taps each dart's entry point. Nothing here detects anything, and the UI
 * says so. Automatic detection has an interface (`src/detector/Detector.ts`) but
 * no implementation and no model.
 */

const MAX_DARTS = 3;
const STEP_LABELS = ['Choose image', 'Calibrate', 'Mark darts', 'View scores'] as const;

const frame = ref<Frame | null>(null);
const calibTaps = ref<Point[]>([]);
const calibration = ref<Calibration | null>(null);
const calibrationError = ref<string | null>(null);
const darts = ref<MarkedDart[]>([]);
const selectedDartId = ref<string | null>(null);
const automatedDetectorAvailable = hasAutomatedDetector();

let dartSequence = 0;

const imageSize = computed<Size>(() =>
  frame.value ? { width: frame.value.width, height: frame.value.height } : { width: 0, height: 0 },
);

const entries = computed<DartEntry[]>(() => {
  const current = calibration.value;
  return darts.value.map((dart) => ({
    ...dart,
    score: current ? scoreImagePoint(current, dart.point) : null,
  }));
});

/** Radius of the outer double ring in image pixels, as a sanity check. */
const boardRadiusPx = computed(() =>
  calibration.value ? calibratedBoardRadius(calibration.value) : 0,
);

const calibrationLooksSmall = computed(() => {
  const size = imageSize.value;
  if (!calibration.value || size.width === 0) return false;
  return boardRadiusPx.value < Math.min(size.width, size.height) * 0.15;
});

const stepIndex = computed(() => {
  if (!frame.value) return 0;
  if (!calibration.value) return 1;
  return darts.value.length < MAX_DARTS ? 2 : 3;
});

/* ------------------------------------------------------------ image input -- */

function onFrame(next: Frame): void {
  releaseFrame(frame.value);
  frame.value = next;
  // A new image invalidates everything measured against the old one.
  calibTaps.value = [];
  calibration.value = null;
  calibrationError.value = null;
  darts.value = [];
  selectedDartId.value = null;
}

function changeImage(): void {
  releaseFrame(frame.value);
  frame.value = null;
  calibTaps.value = [];
  calibration.value = null;
  calibrationError.value = null;
  darts.value = [];
  selectedDartId.value = null;
}

onBeforeUnmount(() => releaseFrame(frame.value));

/* ------------------------------------------------------------ calibration -- */

function recomputeCalibration(): void {
  if (calibTaps.value.length !== CALIBRATION_POINT_COUNT) {
    calibration.value = null;
    calibrationError.value = null;
    return;
  }

  const result = buildCalibration(calibTaps.value, imageSize.value);
  if (result.ok) {
    calibration.value = result.calibration;
    calibrationError.value = null;
  } else {
    calibration.value = null;
    calibrationError.value = result.message;
  }
}

function undoCalibrationTap(): void {
  calibTaps.value = calibTaps.value.slice(0, -1);
  recomputeCalibration();
}

function clearCalibrationTaps(): void {
  calibTaps.value = [];
  recomputeCalibration();
}

function recalibrate(): void {
  calibration.value = null;
  calibTaps.value = [];
  calibrationError.value = null;
  // Scores are only meaningful against the calibration they were measured with.
  darts.value = [];
  selectedDartId.value = null;
}

/* ---------------------------------------------------------------- marking -- */

function onPlace(point: Point): void {
  if (!calibration.value) {
    if (calibTaps.value.length >= CALIBRATION_POINT_COUNT) return;
    calibTaps.value = [...calibTaps.value, point];
    recomputeCalibration();
    return;
  }

  // A selected dart is being corrected; the next tap moves it instead of adding one.
  const selected = selectedDartId.value;
  if (selected) {
    darts.value = darts.value.map((dart) => (dart.id === selected ? { ...dart, point } : dart));
    selectedDartId.value = null;
    return;
  }

  if (darts.value.length >= MAX_DARTS) return;
  dartSequence += 1;
  darts.value = [...darts.value, { id: `dart-${dartSequence}`, point }];
}

function onMarkerMove(payload: { id: string; point: Point }): void {
  if (payload.id.startsWith('cal-')) {
    const index = Number(payload.id.slice(4));
    if (!Number.isInteger(index) || index < 0 || index >= calibTaps.value.length) return;
    calibTaps.value = calibTaps.value.map((point, i) => (i === index ? payload.point : point));
    return;
  }
  darts.value = darts.value.map((dart) =>
    dart.id === payload.id ? { ...dart, point: payload.point } : dart,
  );
}

function onMarkerCommit(): void {
  if (!calibration.value) recomputeCalibration();
}

function onMarkerSelect(id: string): void {
  if (id.startsWith('cal-')) return;
  selectedDartId.value = selectedDartId.value === id ? null : id;
}

function removeDart(id: string): void {
  darts.value = darts.value.filter((dart) => dart.id !== id);
  if (selectedDartId.value === id) selectedDartId.value = null;
}

function undoDart(): void {
  const last = darts.value[darts.value.length - 1];
  if (!last) return;
  removeDart(last.id);
}

function resetDarts(): void {
  darts.value = [];
  selectedDartId.value = null;
}

/* ------------------------------------------------------------------ hints -- */

const tapperMarkers = computed<TapperMarker[]>(() => {
  if (!calibration.value) {
    return calibTaps.value.map((point, index) => ({
      id: `cal-${index}`,
      point,
      label: String(index + 1),
      kind: 'calibration' as const,
    }));
  }
  return darts.value.map((dart, index) => {
    const entry = entries.value[index];
    return {
      id: dart.id,
      point: dart.point,
      label: entry?.score ? entry.score.label : String(index + 1),
      kind: 'dart' as const,
      selected: dart.id === selectedDartId.value,
    };
  });
});

const tapperHint = computed(() => {
  if (!calibration.value) {
    const next = CALIBRATION_REFS[calibTaps.value.length];
    if (next) return `Tap ${calibTaps.value.length + 1} of 4: ${next.label} - ${next.hint}`;
    return 'Drag any of the four points to correct it, or clear the taps and start again.';
  }

  if (selectedDartId.value) {
    const index = darts.value.findIndex((d) => d.id === selectedDartId.value);
    return `Correction mode: tap the image to move dart ${index + 1}, or drag its marker.`;
  }
  if (darts.value.length < MAX_DARTS) {
    const remaining = MAX_DARTS - darts.value.length;
    return `Tap the entry point of each dart. ${remaining} left to mark.`;
  }
  return 'Three darts marked. Drag a marker to correct it, or reset the points to score the next visit.';
});
</script>

<template>
  <div class="stack">
    <header>
      <h1>Steel-tip darts scorer</h1>
      <p class="muted">
        Personal use, on device, no accounts and no cloud. Upload a photo or capture a still, calibrate
        the board, then mark darts by hand.
      </p>
    </header>

    <div class="notice notice--manual">
      <strong>Manual marking - this is not AI scoring</strong>
      <p>
        Every point in this milestone comes from a tap you make. There is no dart detection, no model,
        no trained weights and no inference runtime in this project yet, so nothing here is automated.
      </p>
    </div>

    <nav class="steps" aria-label="Progress">
      <span
        v-for="(label, index) in STEP_LABELS"
        :key="label"
        class="step"
        :class="{ 'step--current': index === stepIndex, 'step--done': index < stepIndex }"
      >
        {{ index + 1 }}. {{ label }}
      </span>
    </nav>

    <section class="card">
      <h2>1. Choose an image</h2>

      <CameraPanel v-if="!frame" @captured="onFrame" />

      <div v-else class="stack">
        <p class="muted">
          {{ frame.origin === 'camera' ? 'Captured from the camera' : 'Uploaded photo' }} -
          {{ frame.width }} x {{ frame.height }} px. A frozen still is used from here on.
        </p>
        <button class="ghost" @click="changeImage">Choose a different image</button>
      </div>
    </section>

    <section v-if="frame" class="card">
      <h2>2. Calibrate the board</h2>

      <template v-if="!calibration">
        <CalibrationSchematic />

        <ImageTapper
          :frame="frame"
          :markers="tapperMarkers"
          :hint="tapperHint"
          @place="onPlace"
          @move="onMarkerMove"
          @commit="onMarkerCommit"
          @select="onMarkerSelect"
        />

        <div class="row">
          <button class="ghost" :disabled="calibTaps.length === 0" @click="undoCalibrationTap">
            Undo last tap
          </button>
          <button class="ghost" :disabled="calibTaps.length === 0" @click="clearCalibrationTaps">
            Clear taps
          </button>
        </div>

        <div v-if="calibrationError" class="notice notice--error">
          <strong>Those four points cannot be used</strong>
          <p>{{ calibrationError }}</p>
        </div>
      </template>

      <div v-else class="stack">
        <div class="notice">
          <strong>Calibrated</strong>
          <p>
            The four reference points define a projective transform from the photo to a top-down board.
            This is a four-point fit, so it is exact at the reference points; any error will be at the
            wires furthest from them.
          </p>
          <p class="muted">
            Outer double ring in this image: about {{ Math.round(boardRadiusPx) }} px radius. Fit residual
            {{ calibration.residual.toExponential(1) }}.
          </p>
        </div>

        <div v-if="calibrationLooksSmall" class="notice notice--warn">
          <strong>The board looks small in this image</strong>
          <p>
            That usually means a tap landed on the board's printed numbers or on the wrong ring, rather
            than on the outer edge of the double ring. Re-calibrate if the darts score oddly.
          </p>
        </div>

        <button class="ghost" @click="recalibrate">Re-calibrate (clears the marked darts)</button>
      </div>
    </section>

    <section v-if="calibration" class="card">
      <h2>3. Mark darts and see scores</h2>

      <ImageTapper
        :frame="frame!"
        :markers="tapperMarkers"
        :calibration="calibration"
        :hint="tapperHint"
        show-board
        @place="onPlace"
        @move="onMarkerMove"
        @commit="onMarkerCommit"
        @select="onMarkerSelect"
      />

      <ScorePanel
        :entries="entries"
        :max-darts="MAX_DARTS"
        :selected-id="selectedDartId"
        @select="onMarkerSelect"
        @remove="removeDart"
        @undo="undoDart"
        @reset="resetDarts"
      />
    </section>

    <section class="card">
      <h2>Automatic detection</h2>
      <div class="notice notice--warn">
        <strong>Not available in this milestone</strong>
        <p>
          Dart detection is specified as an interface only
          (<code>src/detector/Detector.ts</code>), returning dart entry points plus an optional
          confidence. There is no model file, no weights and no inference runtime in this project, and
          the detector registry is empty
          ({{ automatedDetectorAvailable ? 'a detector is registered' : 'no detector is registered' }}),
          so no automated scoring can be selected by accident.
        </p>
      </div>
    </section>

    <section class="card">
      <details>
        <summary>How to run this, and how to test on a phone</summary>

        <h3>Local</h3>
        <pre><code>npm install
npm run dev        # http://localhost:5173
npm test           # Vitest: board geometry, calibration, scoring
npm run build      # vue-tsc --noEmit &amp;&amp; vite build
npm run preview    # serve the production build</code></pre>

        <h3>Phone checklist</h3>
        <ol>
          <li>
            Test the upload path first - it works over any origin, including plain HTTP.
          </li>
          <li>
            Camera access needs a secure context: <code>https://</code> or
            <code>http://localhost</code>. Opening the dev server from the phone by the laptop's LAN IP
            over plain HTTP will not expose the camera.
          </li>
          <li>
            Testing the camera on a real phone needs an HTTPS origin (a static host for
            <code>dist/</code>, or an HTTPS tunnel). Ask before setting either up.
          </li>
          <li>
            Check the permission prompt appears only after the button press, the preview is visible,
            capture freezes the still, and the camera indicator goes out afterwards (tracks stopped).
          </li>
          <li>
            Deny the permission once and confirm the message is readable and the upload fallback still
            works.
          </li>
          <li>
            Rotate the phone and resize the window: markers must stay on the same board features,
            because points are stored in image coordinates.
          </li>
        </ol>
      </details>
    </section>
  </div>
</template>

<style scoped>
pre {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  overflow-x: auto;
  font-size: 0.78rem;
}

h3 {
  font-size: 0.9rem;
  margin: 10px 0 4px;
}

ol {
  margin: 0 0 8px;
  padding-left: 20px;
  font-size: 0.85rem;
  color: var(--muted);
}

code {
  font-size: 0.85em;
}
</style>
