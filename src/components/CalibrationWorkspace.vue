<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import CalibrationSchematic from './CalibrationSchematic.vue';
import ImageViewer from './ImageViewer.vue';
import { rescaleRefPoints, type StoredCalibration } from '../calibration/store';
import type { Frame } from '../camera/frame';
import {
  CALIBRATION_POINT_COUNT,
  CALIBRATION_REFS,
  buildCalibration,
  type Calibration,
} from '../geometry/calibration';
import type { ViewState } from '../geometry/viewTransform';
import type { Point, Size, TapperMarker } from '../types';

/**
 * ---------------------------------------------------------------------------
 * CALIBRATION WORKSPACE
 * ---------------------------------------------------------------------------
 * Four reference wires, ONE at a time, on a full-screen zoomable workspace.
 *
 * The two-stage interaction is the point of this component: a rough tap places
 * the marker, then the marker is dragged (or nudged with the fine-adjust pad)
 * until it is right, and only an explicit Confirm advances. Nothing here
 * requires a precise tap on a small static photo.
 *
 * A saved calibration is offered as a separate, optional first step: the stored
 * points are drawn over the new photo so the user can *see* whether the phone
 * moved, rather than being asked to trust a number.
 */

interface Props {
  frame: Frame;
  view: ViewState;
  /** A stored calibration offered for reuse; null goes straight to tapping. */
  stored?: StoredCalibration | null;
  /** Why a saved calibration is not being offered, if there was one. */
  reuseNote?: string | null;
}

const props = withDefaults(defineProps<Props>(), { stored: null, reuseNote: null });

const emit = defineEmits<{
  accept: [calibration: Calibration];
  cancel: [];
  'update:view': [view: ViewState];
}>();

type Step = 'align' | 'point' | 'review';

const step = ref<Step>(props.stored ? 'align' : 'point');
/** Confirmed reference points, in tap order, in image pixels. */
const placed = ref<Point[]>([]);
/** The point currently being placed or adjusted, if any. */
const draft = ref<Point | null>(null);
const error = ref<string | null>(null);
const fineAdjust = ref(false);
const showDiagram = ref(false);

const imageSize = computed<Size>(() => ({ width: props.frame.width, height: props.frame.height }));

watch(
  () => props.frame,
  () => {
    step.value = props.stored ? 'align' : 'point';
    placed.value = [];
    draft.value = null;
    error.value = null;
    fineAdjust.value = false;
    showDiagram.value = false;
  },
);

/* ------------------------------------------------------------- alignment -- */

const alignRefs = computed<Point[]>(() =>
  props.stored ? rescaleRefPoints(props.stored, imageSize.value) : [],
);

const alignResult = computed(() =>
  alignRefs.value.length === CALIBRATION_POINT_COUNT
    ? buildCalibration(alignRefs.value, imageSize.value)
    : null,
);

const alignCalibration = computed(() => (alignResult.value?.ok ? alignResult.value.calibration : null));

/* ---------------------------------------------------------------- review -- */

const reviewResult = computed(() =>
  placed.value.length === CALIBRATION_POINT_COUNT
    ? buildCalibration(placed.value, imageSize.value)
    : null,
);

const reviewCalibration = computed(() => (reviewResult.value?.ok ? reviewResult.value.calibration : null));

/* ---------------------------------------------------------------- inputs -- */

const activeRef = computed(() => CALIBRATION_REFS[placed.value.length] ?? null);

const activeId = computed(() => (draft.value ? 'draft' : null));

const shownCalibration = computed<Calibration | null>(() => {
  if (step.value === 'align') return alignCalibration.value;
  if (step.value === 'review') return reviewCalibration.value;
  return null;
});

const markers = computed<TapperMarker[]>(() => {
  const source = step.value === 'align' ? alignRefs.value : placed.value;
  const list: TapperMarker[] = source.map((point, index) => ({
    id: `cal-${index}`,
    point,
    label: String(index + 1),
    kind: 'calibration' as const,
  }));
  if (step.value === 'point' && draft.value) {
    list.push({
      id: 'draft',
      point: draft.value,
      label: String(placed.value.length + 1),
      kind: 'calibration',
    });
  }
  return list;
});

const progressLabel = computed(() => {
  if (step.value === 'align') return 'Saved calibration';
  if (step.value === 'review') return 'Review';
  return `Point ${placed.value.length + 1} of ${CALIBRATION_POINT_COUNT}`;
});

const instruction = computed(() => {
  if (step.value === 'align') {
    return 'Check the saved points still sit on the 20/1, 6/10, 3/19 and 11/14 wires.';
  }
  if (step.value === 'review') {
    return 'Check the four points and the projected board, then accept.';
  }
  return 'Tap roughly to place the marker, drag it onto the wire, then confirm.';
});

const shownError = computed(() => {
  if (error.value) return error.value;
  if (step.value === 'align' && alignResult.value && !alignResult.value.ok) return alignResult.value.message;
  if (step.value === 'review' && reviewResult.value && !reviewResult.value.ok) {
    return reviewResult.value.message;
  }
  return null;
});

const canAccept = computed(() => shownCalibration.value !== null);

/* -------------------------------------------------------------- gestures -- */

function onPlace(point: Point): void {
  if (step.value !== 'point') return;
  // A rough tap only ever places or re-places the current draft; it never
  // confirms, so a stray touch during a pinch cannot advance the wizard.
  draft.value = point;
  error.value = null;
}

function onMove(payload: { id: string; point: Point }): void {
  if (step.value === 'align') return;

  if (payload.id === 'draft') {
    draft.value = payload.point;
    error.value = null;
    return;
  }

  const match = /^cal-(\d+)$/.exec(payload.id);
  if (!match) return;
  const index = Number(match[1]);
  if (index >= placed.value.length) return;

  // Dragging a confirmed marker re-opens that reference and keeps following the
  // finger, so an earlier point can be corrected without losing the rest.
  placed.value = placed.value.slice(0, index);
  draft.value = payload.point;
  if (step.value === 'review') step.value = 'point';
  error.value = null;
}

function onSelect(id: string): void {
  if (step.value === 'align') return;
  const match = /^cal-(\d+)$/.exec(id);
  if (!match) return;
  const index = Number(match[1]);
  if (index >= placed.value.length) return;
  const point = placed.value[index];
  placed.value = placed.value.slice(0, index);
  draft.value = { ...point };
  if (step.value === 'review') step.value = 'point';
  error.value = null;
}

/* --------------------------------------------------------------- actions -- */

function confirmPoint(): void {
  if (step.value !== 'point' || !draft.value) return;
  const next = [...placed.value, draft.value];
  placed.value = next;
  draft.value = null;
  error.value = null;
  if (next.length === CALIBRATION_POINT_COUNT) step.value = 'review';
}

/** Undo: drop the pending marker, or remove the last confirmed point. */
function undoPoint(): void {
  error.value = null;
  if (draft.value) {
    draft.value = null;
    return;
  }
  if (placed.value.length === 0) return;
  placed.value = placed.value.slice(0, -1);
  if (step.value === 'review') step.value = 'point';
}

/** Back: return to the previous reference, keeping its point editable. */
function goBack(): void {
  error.value = null;
  if (draft.value) {
    draft.value = null;
    return;
  }
  const last = placed.value[placed.value.length - 1];
  if (!last) {
    emit('cancel');
    return;
  }
  placed.value = placed.value.slice(0, -1);
  draft.value = last;
  if (step.value === 'review') step.value = 'point';
}

function restart(): void {
  placed.value = [];
  draft.value = null;
  error.value = null;
  step.value = 'point';
}

/** Leave the reuse offer and tap the four wires by hand. */
function recalibrate(): void {
  restart();
}

function accept(): void {
  const calibration = shownCalibration.value;
  if (!calibration) return;
  emit('accept', calibration);
}
</script>

<template>
  <div class="calib">
    <header class="calib-bar">
      <div class="calib-bar-top">
        <span class="calib-progress">{{ progressLabel }}</span>
        <span class="calib-bar-spacer"></span>
        <button
          v-if="step === 'point'"
          class="tiny"
          :class="fineAdjust ? 'primary' : 'ghost'"
          :aria-pressed="fineAdjust"
          @click="fineAdjust = !fineAdjust"
        >
          Fine adjust
        </button>
        <button
          v-if="step !== 'align'"
          class="tiny ghost"
          :aria-pressed="showDiagram"
          @click="showDiagram = !showDiagram"
        >
          Diagram
        </button>
        <button class="tiny ghost" aria-label="Close calibration" @click="emit('cancel')">Close</button>
      </div>

      <p class="calib-instruction">{{ instruction }}</p>

      <p v-if="step === 'point' && activeRef" class="calib-sub">
        <strong>{{ activeRef.label }}</strong> - {{ activeRef.hint }}
      </p>
    </header>

    <div class="calib-body">
      <ImageViewer
        :frame="frame"
        :markers="markers"
        :view="view"
        :calibration="shownCalibration"
        :show-board="shownCalibration !== null"
        :active-id="activeId"
        :draggable="step !== 'align'"
        :fine-adjust="fineAdjust"
        @place="onPlace"
        @move="onMove"
        @select="onSelect"
        @update:view="emit('update:view', $event)"
      />

      <aside v-if="showDiagram && step !== 'align'" class="calib-diagram">
        <CalibrationSchematic :active-index="step === 'point' ? placed.length : null" compact />
      </aside>
    </div>

    <p v-if="shownError" class="calib-message calib-message--error">{{ shownError }}</p>
    <p v-else-if="reuseNote && step === 'point'" class="calib-message">{{ reuseNote }}</p>

    <footer class="calib-actions">
      <template v-if="step === 'align'">
        <button class="ghost" @click="recalibrate">Phone moved - recalibrate</button>
        <button class="primary grow" :disabled="!canAccept" @click="accept">Calibration still matches</button>
      </template>

      <template v-else-if="step === 'point'">
        <div class="calib-actions-row">
          <button class="ghost" :disabled="placed.length === 0 && !draft" @click="goBack">Back</button>
          <button class="ghost" :disabled="placed.length === 0 && !draft" @click="undoPoint">Undo</button>
          <button class="ghost" :disabled="placed.length === 0" @click="restart">Restart</button>
        </div>
        <button class="primary" :disabled="!draft" @click="confirmPoint">
          {{ draft ? `Confirm point ${placed.length + 1} of ${CALIBRATION_POINT_COUNT}` : 'Tap the wire to place a marker' }}
        </button>
      </template>

      <template v-else>
        <div class="calib-actions-row">
          <button class="ghost" @click="goBack">Adjust a point</button>
          <button class="ghost" @click="restart">Start over</button>
        </div>
        <button class="primary" :disabled="!canAccept" @click="accept">Accept calibration</button>
      </template>
    </footer>
  </div>
</template>

<style scoped>
.calib {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  gap: 8px;
}

.calib-bar {
  flex: 0 0 auto;
}

.calib-bar-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.calib-progress {
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--accent);
}

.calib-bar-spacer {
  flex: 1 1 auto;
}

.calib-instruction {
  margin: 4px 0 0;
  font-size: 0.86rem;
}

.calib-sub {
  margin: 2px 0 0;
  font-size: 0.82rem;
  color: var(--muted);
}

.calib-body {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

.calib-diagram {
  position: absolute;
  top: 8px;
  right: 8px;
  padding: 6px;
  border-radius: 12px;
  background: rgba(13, 17, 23, 0.88);
  border: 1px solid var(--border);
  z-index: 7;
}

.calib-message {
  flex: 0 0 auto;
  margin: 0;
  font-size: 0.82rem;
  color: var(--muted);
}

.calib-message--error {
  color: var(--danger);
}

.calib-actions {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.calib-actions-row {
  display: flex;
  gap: 6px;
}

.calib-actions-row > button {
  flex: 1 1 auto;
  min-height: 40px;
}
</style>
