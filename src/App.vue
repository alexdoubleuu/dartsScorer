<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import CameraPanel from './components/CameraPanel.vue';
import CalibrationWorkspace from './components/CalibrationWorkspace.vue';
import PlayScreen from './components/PlayScreen.vue';
import ScoreCorrection from './components/ScoreCorrection.vue';
import { assessReuse, loadCalibration, saveCalibration, type StoredCalibration } from './calibration/store';
import { releaseFrame, type Frame } from './camera/frame';
import { hasAutomatedDetector } from './detector/Detector';
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
 * HONEST STATUS: this build has no dart detector. `hasAutomatedDetector()` is
 * false, the status chip says "Manual mode", and no code path can claim to be
 * "detecting" anything. Automatic detection is a separate, unimplemented piece
 * of work and this UI redesign does not pretend otherwise.
 *
 * All state that describes the photo - calibration reference points, dart
 * entry points, score overrides - is kept in SOURCE-IMAGE pixel coordinates.
 * Screen positions exist only inside the workspace transform.
 */

const MAX_DARTS = 3;

type Phase = 'capture' | 'calibrate' | 'play';

/** Detection states this build can actually show. There is deliberately no
 * "detecting" state: nothing runs inference, so nothing may claim to. */
type DetectionState = 'manual' | 'loading' | 'ready' | 'error';

const DETECTION_LABEL: Record<DetectionState, string> = {
  manual: 'Manual mode',
  loading: 'Model loading',
  ready: 'Ready',
  error: 'Detector error',
};

const phase = ref<Phase>('capture');
const frame = ref<Frame | null>(null);
const calibration = ref<Calibration | null>(null);
const darts = ref<MarkedDart[]>([]);
const selectedDartId = ref<string | null>(null);
const manualMode = ref(true);
const view = ref<ViewState>({ zoom: 1, focus: { x: 0, y: 0 } });
const reuseCandidate = ref<StoredCalibration | null>(null);
const reuseNote = ref<string | null>(null);
const correctingId = ref<string | null>(null);

let dartSequence = 0;

onBeforeUnmount(() => releaseFrame(frame.value));

/* -------------------------------------------------------------- detection -- */

const detectionState = computed<DetectionState>(() => (hasAutomatedDetector() ? 'ready' : 'manual'));

const statusLabel = computed(() => DETECTION_LABEL[detectionState.value]);

const statusDetail = computed(() =>
  hasAutomatedDetector()
    ? 'An automated detector is registered.'
    : 'Automatic dart detection is not implemented in this build: no model, no weights, no inference runtime. Every point is entered by hand.',
);

/* ------------------------------------------------------------- image input -- */

function resetForNewImage(): void {
  darts.value = [];
  selectedDartId.value = null;
  calibration.value = null;
  correctingId.value = null;
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
          Phone only, on device, no accounts. Take a photo of the board, calibrate it once, then mark
          where each dart landed.
        </p>
      </header>

      <p class="notice notice--manual">
        <strong>Manual marking - not AI scoring</strong>
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
