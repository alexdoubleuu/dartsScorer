<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import CameraPanel from './components/CameraPanel.vue';
import CalibrationWorkspace from './components/CalibrationWorkspace.vue';
import PlayScreen from './components/PlayScreen.vue';
import ScoreCorrection from './components/ScoreCorrection.vue';
import { assessReuse, loadCalibration, saveCalibration, type StoredCalibration } from './calibration/store';
import { releaseFrame, type Frame } from './camera/frame';
import {
  buildOverlayPng,
  diagnosticsToJson,
  downloadBlob,
  type DetectionDiagnostics,
} from './detector/debugExport';
import { DEFAULT_DETECTOR_ID, getDetector, type DartDetection } from './detector/Detector';
import { imageDataFromUrl } from './detector/imageInput';
import type { Calibration } from './geometry/calibration';
import { defaultView, type ViewState } from './geometry/viewTransform';
import { scoreImagePoint, type DartEntry, type DartScore, type MarkedDart } from './scoring/score';
import type { Point, TapperMarker } from './types';

/**
 * ---------------------------------------------------------------------------
 * PHONE-FIRST DARTS SCORER - SHELL
 * ---------------------------------------------------------------------------
 * Three screens, and the board image is the main content of the two that
 * matter: calibrate, then play. Everything else is a compact bar or a
 * collapsible sheet so the photo gets the screen.
 *
 * DETECTION: a real on-device YOLOv8 model (see `detector/yolov8Detector.ts`)
 * is bundled and can be run from the Detect button. Its output is dart ENTRY
 * POINTS in image pixels, which flow through exactly the same scoring path as
 * a hand-marked point. Manual marking stays available as a separate mode; a
 * detected point is an ordinary dart that can still be dragged or corrected.
 *
 * All state that describes the photo - calibration reference points, dart
 * entry points, score overrides - is kept in SOURCE-IMAGE pixel coordinates.
 * Screen positions exist only inside the workspace transform.
 */

const MAX_DARTS = 3;

type Phase = 'capture' | 'calibrate' | 'play';

/** What the status chip can honestly say. */
type DetectionState = 'manual' | 'loading' | 'detecting' | 'ready' | 'error';

const DETECTION_LABEL: Record<DetectionState, string> = {
  manual: 'Manual mode',
  loading: 'Loading model',
  detecting: 'Detecting',
  ready: 'Detector ready',
  error: 'Detector error',
};

const phase = ref<Phase>('capture');
const frame = ref<Frame | null>(null);
const calibration = ref<Calibration | null>(null);
const darts = ref<MarkedDart[]>([]);
const selectedDartId = ref<string | null>(null);
const manualMode = ref(false);
const view = ref<ViewState>({ zoom: 1, focus: { x: 0, y: 0 } });
const reuseCandidate = ref<StoredCalibration | null>(null);
const reuseNote = ref<string | null>(null);
const correctingId = ref<string | null>(null);

let dartSequence = 0;

onBeforeUnmount(() => releaseFrame(frame.value));

/* -------------------------------------------------------------- detection -- */

const detector = getDetector(DEFAULT_DETECTOR_ID);
const detectBusy = ref(false);
const detectError = ref<string | null>(null);
const detectNote = ref<string | null>(null);
/** Full record of the last Detect press, shown in the debug panel and exportable. */
const detectDiagnostics = ref<DetectionDiagnostics | null>(null);

/** More darts marked than a visit scores: the result needs a human review. */
const needsReview = computed(() => darts.value.length > MAX_DARTS);

const detectionState = computed<DetectionState>(() => {
  if (detectError.value) return 'error';
  if (detectBusy.value) return 'detecting';
  return detector ? 'ready' : 'manual';
});

const statusLabel = computed(() => DETECTION_LABEL[detectionState.value]);

const statusDetail = computed(() => {
  if (detectError.value) return `Detection failed: ${detectError.value}`;
  if (detectNote.value) return detectNote.value;
  return detector
    ? `${detector.name} is bundled with this app. Press Detect to find the darts automatically, or turn on Manual to place them by hand.`
    : 'Automatic dart detection is not available in this build. Every point is entered by hand.';
});

/**
 * Run the real detector on the current photo and add EVERY detection it makes
 * as an ordinary dart, so each one is scored, drawn and corrected by the same
 * code as a hand-marked point.
 *
 * There is deliberately no three-dart truncation here: dropping detections
 * silently hid the model's mistakes. If the result is larger than a visit, the
 * UI marks it as needing review and the user removes or fixes the extras.
 * Everything measurable about the press is recorded for phone testing.
 */
async function detectDarts(): Promise<void> {
  const currentFrame = frame.value;
  const active = detector;
  if (!currentFrame || !active || detectBusy.value) return;

  detectBusy.value = true;
  detectError.value = null;
  detectNote.value = null;

  const imageSize = { width: currentFrame.width, height: currentFrame.height };
  const startedAt = performance.now();
  let modelLoadMs = 0;
  let inferenceMs = 0;
  let found: DartDetection[] = [];
  const errors: string[] = [];

  try {
    const imageData = await imageDataFromUrl(currentFrame.url, imageSize);

    const loadStart = performance.now();
    await active.load({ imageSize });
    modelLoadMs = performance.now() - loadStart;

    const inferenceStart = performance.now();
    found = await active.detect({ imageData, imageSize });
    inferenceMs = performance.now() - inferenceStart;

    darts.value = [
      ...darts.value,
      ...found.map((detection) => {
        dartSequence += 1;
        return { id: `dart-${dartSequence}`, point: detection.point };
      }),
    ];

    if (found.length === 0) {
      detectNote.value = 'Detected no darts. Mark them by hand, or try a clearer photo.';
    } else {
      const confidences = found
        .map((detection) => (detection.confidence ?? 0).toFixed(2))
        .join(', ');
      const over = darts.value.length - MAX_DARTS;
      detectNote.value =
        `Detected ${found.length} dart${found.length === 1 ? '' : 's'} (confidence ${confidences})` +
        (over > 0
          ? `. That is ${darts.value.length} markers, more than a three-dart visit, so this result needs review: remove the extras or fix their scores.`
          : '.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    detectError.value = message;
    errors.push(message);
  } finally {
    detectDiagnostics.value = {
      detectorName: active.name,
      imageWidth: imageSize.width,
      imageHeight: imageSize.height,
      modelLoadMs: Math.round(modelLoadMs),
      inferenceMs: Math.round(inferenceMs),
      totalMs: Math.round(performance.now() - startedAt),
      candidateCount: found.length,
      retainedCount: found.length,
      candidates: found.map((detection) => ({
        point: { ...detection.point },
        norm: {
          x: detection.point.x / imageSize.width,
          y: detection.point.y / imageSize.height,
        },
        confidence: detection.confidence,
      })),
      errors,
    };
    detectBusy.value = false;
  }
}

/* ------------------------------------------------------- debug export ------ */

function fileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Save the photo with the projected board and every candidate drawn on it. */
async function exportDebugOverlay(): Promise<void> {
  const currentFrame = frame.value;
  const diagnostics = detectDiagnostics.value;
  if (!currentFrame || !diagnostics) return;
  try {
    const blob = await buildOverlayPng(currentFrame, calibration.value, diagnostics);
    downloadBlob(blob, `dart-detect-overlay-${fileStamp()}.png`);
  } catch (error) {
    detectError.value = error instanceof Error ? error.message : String(error);
  }
}

/** Save every candidate coordinate and timing as JSON. */
function exportPredictions(): void {
  const diagnostics = detectDiagnostics.value;
  if (!diagnostics) return;
  downloadBlob(
    new Blob([diagnosticsToJson(diagnostics)], { type: 'application/json' }),
    `dart-predictions-${fileStamp()}.json`,
  );
}

/* ------------------------------------------------------------- image input -- */

function resetForNewImage(): void {
  darts.value = [];
  selectedDartId.value = null;
  calibration.value = null;
  correctingId.value = null;
  detectError.value = null;
  detectNote.value = null;
  detectDiagnostics.value = null;
}

function onFrame(next: Frame): void {
  releaseFrame(frame.value);
  frame.value = next;
  resetForNewImage();
  view.value = defaultView({ width: next.width, height: next.height });

  // Offer a stored calibration only when the new photo plausibly matches the
  // one it was measured on. The user still sees it drawn on the photo before
  // trusting it.
  reuseCandidate.value = null;
  reuseNote.value = null;
  const stored = loadCalibration();
  if (stored) {
    const assessment = assessReuse(
      stored,
      { width: next.width, height: next.height },
      next.camera ?? null,
    );
    if (assessment.reusable) {
      reuseCandidate.value = stored;
      reuseNote.value = assessment.notes.join(' ') || null;
    } else {
      reuseNote.value = assessment.blockers.join(' ');
    }
  }

  phase.value = 'calibrate';
}

function changeImage(): void {
  releaseFrame(frame.value);
  frame.value = null;
  resetForNewImage();
  reuseCandidate.value = null;
  reuseNote.value = null;
  phase.value = 'capture';
}

function resumeCalibration(): void {
  if (frame.value) phase.value = 'calibrate';
}

/* ------------------------------------------------------------ calibration -- */

function onCalibrationAccepted(next: Calibration): void {
  calibration.value = next;
  saveCalibration({
    version: 1,
    refPoints: next.refPoints.map((point) => ({ ...point })),
    imageSize: { ...next.imageSize },
    camera: frame.value?.camera ?? null,
    savedAt: Date.now(),
  });
  reuseCandidate.value = null;
  reuseNote.value = null;
  selectedDartId.value = null;
  phase.value = 'play';
}

/* ----------------------------------------------------------------- scoring -- */

const entries = computed<DartEntry[]>(() =>
  darts.value.map((dart) => {
    if (dart.override) {
      return { ...dart, score: dart.override, corrected: true };
    }
    const current = calibration.value;
    return {
      ...dart,
      score: current ? scoreImagePoint(current, dart.point) : null,
      corrected: false,
    };
  }),
);

const markers = computed<TapperMarker[]>(() =>
  entries.value.map((entry, index) => ({
    id: entry.id,
    point: entry.point,
    label: entry.score ? entry.score.label : String(index + 1),
    kind: 'dart' as const,
    selected: entry.id === selectedDartId.value,
  })),
);

const correctingEntry = computed<DartEntry | null>(
  () => entries.value.find((entry) => entry.id === correctingId.value) ?? null,
);

const correctingIndex = computed(() =>
  entries.value.findIndex((entry) => entry.id === correctingId.value),
);

function onPlace(point: Point): void {
  if (!manualMode.value) return;
  if (darts.value.length >= MAX_DARTS) return;
  dartSequence += 1;
  darts.value = [...darts.value, { id: `dart-${dartSequence}`, point }];
}

function onMarkerMove(payload: { id: string; point: Point }): void {
  darts.value = darts.value.map((dart) =>
    dart.id === payload.id ? { ...dart, point: payload.point } : dart,
  );
}

function onMarkerSelect(id: string): void {
  selectedDartId.value = selectedDartId.value === id ? null : id;
}

function removeDart(id: string): void {
  darts.value = darts.value.filter((dart) => dart.id !== id);
  if (selectedDartId.value === id) selectedDartId.value = null;
}

function undoDart(): void {
  const last = darts.value[darts.value.length - 1];
  if (last) removeDart(last.id);
}

function resetDarts(): void {
  darts.value = [];
  selectedDartId.value = null;
}

/* --------------------------------------------------------------- correction -- */

function startCorrection(id: string): void {
  correctingId.value = id;
}

function applyCorrection(score: DartScore): void {
  const id = correctingId.value;
  if (!id) return;
  darts.value = darts.value.map((dart) => (dart.id === id ? { ...dart, override: score } : dart));
  correctingId.value = null;
}

function clearCorrection(): void {
  const id = correctingId.value;
  if (!id) return;
  darts.value = darts.value.map((dart) => {
    if (dart.id !== id) return dart;
    const next = { ...dart };
    delete next.override;
    return next;
  });
  correctingId.value = null;
}
</script>

<template>
  <div class="shell">
    <section v-if="phase === 'capture'" class="capture stack">
      <header class="capture-head">
        <h1>Steel-tip darts scorer</h1>
        <p class="muted">
          Phone only, on device, no accounts. Take a photo of the board, calibrate it once, then let
          the built-in detector find the darts - or mark them by hand if you prefer.
        </p>
      </header>

      <p class="notice" :class="detectionState === 'error' ? 'notice--error' : 'notice--manual'">
        <strong>On-device detection</strong>
        {{ statusDetail }}
      </p>

      <CameraPanel v-if="!frame" @captured="onFrame" />

      <div v-else class="stack">
        <p class="muted">
          {{ frame.origin === 'camera' ? 'Captured from the camera' : 'Uploaded photo' }} -
          {{ frame.width }} x {{ frame.height }} px.
        </p>
        <button class="primary" @click="resumeCalibration">Continue to calibration</button>
        <button class="ghost" @click="changeImage">Choose a different image</button>
      </div>
    </section>

    <CalibrationWorkspace
      v-else-if="phase === 'calibrate' && frame"
      :frame="frame"
      :view="view"
      :stored="reuseCandidate"
      :reuse-note="reuseNote"
      @accept="onCalibrationAccepted"
      @cancel="changeImage"
      @update:view="view = $event"
    />

    <PlayScreen
      v-else-if="phase === 'play' && frame && calibration"
      :frame="frame"
      :calibration="calibration"
      :entries="entries"
      :markers="markers"
      :view="view"
      :manual-mode="manualMode"
      :max-darts="MAX_DARTS"
      :active-id="selectedDartId"
      :status-label="statusLabel"
      :status-detail="statusDetail"
      :detecting="detectBusy"
      :detect-error="detectError"
      :diagnostics="detectDiagnostics"
      :needs-review="needsReview"
      @detect="detectDarts"
      @export-overlay="exportDebugOverlay"
      @export-json="exportPredictions"
      @place="onPlace"
      @move="onMarkerMove"
      @select="onMarkerSelect"
      @remove="removeDart"
      @fix-score="startCorrection"
      @undo="undoDart"
      @reset="resetDarts"
      @toggle-manual="manualMode = !manualMode"
      @new-photo="changeImage"
      @update:view="view = $event"
    />

    <ScoreCorrection
      v-if="correctingEntry"
      :entry="correctingEntry"
      :index="correctingIndex"
      @apply="applyCorrection"
      @clear="clearCorrection"
      @cancel="correctingId = null"
    />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  padding: max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right))
    calc(8px + env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
  gap: 8px;
}

.capture {
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}

.capture-head h1 {
  margin-bottom: 2px;
}
</style>
