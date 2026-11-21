<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ImageViewer from './ImageViewer.vue';
import type { RingId } from '../board/boardModel';
import type { Frame } from '../camera/frame';
import type { DetectionDiagnostics } from '../detector/debugExport';
import type { DetectorTrace } from '../detector/Detector';
import type { Calibration } from '../geometry/calibration';
import type { ViewState } from '../geometry/viewTransform';
import { sumScores, type DartEntry } from '../scoring/score';
import type { Point, TapperMarker } from '../types';

/**
 * PLAYING SCREEN
 *
 * The board view is the screen. Everything else - status, the current visit,
 * per-dart corrections - lives in one compact bar and a collapsible bottom
 * sheet, so the image is never permanently shrunk to make room for chrome.
 *
 * Detect runs the real bundled detector; every detection becomes an ordinary
 * dart. Manual mode doubles as the debug mode: it reveals the full candidate
 * list with confidences and the timings, and offers the overlay/JSON exports
 * used to check detection on a phone.
 */

interface Props {
  frame: Frame;
  calibration: Calibration;
  entries: DartEntry[];
  markers: TapperMarker[];
  view: ViewState;
  manualMode: boolean;
  maxDarts: number;
  /** The dart whose marker is currently active (editable). */
  activeId?: string | null;
  statusLabel: string;
  statusDetail: string;
  /** A detection is in flight. */
  detecting?: boolean;
  /** The last detection failure, shown prominently. */
  detectError?: string | null;
  /** Record of the last Detect press, shown in debug mode. */
  diagnostics?: DetectionDiagnostics | null;
  /** Raw class-4 candidates and production filter decisions. */
  trace?: DetectorTrace | null;
  /** More darts are marked than a visit scores. */
  needsReview?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  activeId: null,
  detecting: false,
  detectError: null,
  diagnostics: null,
  trace: null,
  needsReview: false,
});

const emit = defineEmits<{
  place: [point: Point];
  move: [payload: { id: string; point: Point }];
  'update:view': [view: ViewState];
  select: [id: string];
  remove: [id: string];
  'fix-score': [id: string];
  undo: [];
  reset: [];
  detect: [];
  'save-debug-case': [];
  'toggle-manual': [];
  'new-photo': [];
}>();

const RING_TEXT: Record<RingId, string> = {
  'inner-bull': 'Inner bull',
  'outer-bull': 'Outer bull',
  'inner-single': 'Inner single',
  treble: 'Treble x3',
  'outer-single': 'Outer single',
  double: 'Double x2',
  'off-board': 'Off the board',
};

const sheetOpen = ref(false);
const fullscreen = ref(false);

// Manual mode is the debug mode: opening it reveals the detection diagnostics,
// so bring the sheet up with it.
watch(
  () => props.manualMode,
  (manual) => {
    if (manual) sheetOpen.value = true;
  },
);
watch(
  () => props.diagnostics,
  (diagnostics) => {
    if (diagnostics) sheetOpen.value = true;
  },
);

const total = computed(() => sumScores(props.entries.flatMap((entry) => (entry.score ? [entry.score] : []))));
const selectedId = computed(() => props.activeId ?? null);
const diagnostics = computed(() => props.diagnostics ?? null);
const trace = computed(() => props.trace ?? null);
const candidateCount = computed(() => diagnostics.value?.candidateCount ?? 0);

/** Three fixed slots so the visit reads the same shape all the way through. */
const slots = computed(() =>
  Array.from({ length: props.maxDarts }, (_, index) => {
    const entry = props.entries[index] ?? null;
    return {
      key: entry?.id ?? `empty-${index}`,
      label: entry?.score?.label ?? null,
      corrected: entry?.corrected ?? false,
      index,
    };
  }),
);

const hint = computed(() => {
  if (props.detecting) return 'Running the detector on this photo...';
  if (!props.manualMode) {
    return 'Press Detect to find the darts on this photo, or switch on Manual to place them by hand.';
  }
  if (selectedId.value) return 'Drag the marker, or nudge it with the pad. Tap empty board to place the next dart.';
  if (props.needsReview) return 'More markers than a visit. Remove the extras from the sheet, or fix their scores.';
  if (props.entries.length >= props.maxDarts) return 'Three darts marked. Fix a score, undo, or reset for the next visit.';
  return 'Tap the board where the dart entered. A magnifier appears so your finger never hides the point.';
});

function onPlace(point: Point): void {
  if (!props.manualMode) return;
  emit('place', point);
}

function formatConfidence(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3);
}
</script>

<template>
  <div class="play" :class="{ 'play--full': fullscreen }">
    <header class="play-bar">
      <span class="status-chip" :title="statusDetail">{{ statusLabel }}</span>
      <button class="tiny primary" :disabled="detecting" @click="emit('detect')">
        {{ detecting ? 'Detecting...' : 'Detect' }}
      </button>
      <button
        class="tiny"
        :class="{ primary: manualMode, ghost: !manualMode }"
        :aria-pressed="manualMode"
        @click="emit('toggle-manual')"
      >
        Manual
      </button>
      <button
        v-if="!fullscreen"
        class="tiny ghost"
        aria-label="Full screen board view"
        @click="fullscreen = true"
      >
        Full
      </button>
      <button class="tiny ghost" aria-label="Take a new photo" @click="emit('new-photo')">New photo</button>
    </header>

    <p v-if="detectError" class="play-error" role="alert">{{ detectError }}</p>

    <p v-if="needsReview" class="play-review" role="status">
      {{ entries.length }} darts are marked but a visit scores {{ maxDarts }}. This result needs
      review: open the sheet and remove the extra markers, or fix their scores.
    </p>

    <div class="play-body">
      <ImageViewer
        :frame="frame"
        :markers="markers"
        :view="view"
        :calibration="calibration"
        show-board
        :active-id="selectedId"
        :draggable="manualMode"
        :fine-adjust="manualMode"
        :hint="hint"
        @place="onPlace"
        @move="emit('move', $event)"
        @select="emit('select', $event)"
        @update:view="emit('update:view', $event)"
      />

      <button
        v-if="fullscreen"
        class="play-exit"
        aria-label="Exit full screen"
        @click="fullscreen = false"
      >
        Exit full screen
      </button>
    </div>

    <section v-if="!fullscreen" class="sheet" :class="{ 'sheet--open': sheetOpen }">
      <button class="sheet-handle" :aria-expanded="sheetOpen" @click="sheetOpen = !sheetOpen">
        <span class="sheet-grip" aria-hidden="true"></span>
        <span class="sheet-peek">
          <span class="sheet-slots">
            <span
              v-for="slot in slots"
              :key="slot.key"
              class="slot"
              :class="{ 'slot--empty': slot.label === null, 'slot--fixed': slot.corrected }"
            >
              {{ slot.label ?? '-' }}
            </span>
          </span>
          <span class="sheet-total">
            <span class="sheet-total-label">Visit</span>
            <span class="sheet-total-value">{{ total }}</span>
          </span>
        </span>
        <span class="sheet-chevron" aria-hidden="true">{{ sheetOpen ? '\u25be' : '\u25b4' }}</span>
      </button>

      <div v-if="sheetOpen" class="sheet-body">
        <ul v-if="entries.length" class="sheet-list">
          <li v-for="(entry, index) in entries" :key="entry.id" class="sheet-row">
            <span class="sheet-row-badge">{{ index + 1 }}</span>
            <span class="sheet-row-text">
              <span class="sheet-row-label">{{ entry.score ? entry.score.label : 'Unscorable' }}</span>
              <span class="sheet-row-meta">
                <template v-if="entry.score">
                  {{ entry.score.score }} points<span v-if="entry.corrected"> - corrected</span>
                  <template v-else> - {{ RING_TEXT[entry.score.ring] }}</template>
                </template>
                <template v-else>This point cannot be scored. Move or remove it.</template>
              </span>
            </span>
            <button class="tiny" @click="emit('fix-score', entry.id)">Fix score</button>
            <button class="tiny danger" @click="emit('remove', entry.id)">Remove</button>
          </li>
        </ul>

        <p v-else class="muted">No darts marked for this visit yet.</p>

        <div class="sheet-actions">
          <button class="ghost" :disabled="entries.length === 0" @click="emit('undo')">Undo</button>
          <button class="danger" :disabled="entries.length === 0" @click="emit('reset')">Reset visit</button>
        </div>

        <section v-if="manualMode || diagnostics" class="debug">
          <h2 class="debug-title">Detection diagnostics</h2>
          <p v-if="!diagnostics" class="muted">No detection has run on this photo yet. Press Detect.</p>
          <template v-else>
            <dl class="debug-grid">
              <div><dt>Source</dt><dd>{{ diagnostics.imageWidth }} x {{ diagnostics.imageHeight }} px</dd></div>
              <div><dt>Model load</dt><dd>{{ diagnostics.modelLoadMs }} ms</dd></div>
              <div><dt>Preprocess</dt><dd>{{ diagnostics.preprocessingMs }} ms</dd></div>
              <div><dt>Inference</dt><dd>{{ diagnostics.inferenceMs }} ms</dd></div>
              <div><dt>Decode</dt><dd>{{ diagnostics.postprocessingMs }} ms</dd></div>
              <div><dt>Detect-to-render</dt><dd>{{ diagnostics.totalMs }} ms</dd></div>
              <div><dt>Class-4 candidates</dt><dd>{{ candidateCount }}</dd></div>
              <div><dt>Retained</dt><dd>{{ diagnostics.retainedCount }}</dd></div>
              <div><dt>Marked</dt><dd>{{ entries.length }}</dd></div>
            </dl>

            <ul v-if="trace" class="debug-list">
              <li v-for="(candidate, index) in trace.candidates" :key="candidate.anchor">
                <span class="debug-index">#{{ index + 1 }}</span>
                <span class="debug-conf">{{ formatConfidence(candidate.confidence) }}</span>
                <span class="debug-status" :class="`debug-status--${candidate.disposition}`">
                  {{ candidate.disposition }}
                  <template v-if="candidate.suppressedByAnchor !== undefined">
                    by {{ candidate.suppressedByAnchor }}
                  </template>
                </span>
                <span class="debug-xy">
                  centre {{ candidate.point.x.toFixed(1) }}, {{ candidate.point.y.toFixed(1) }} px;
                  box {{ candidate.boxSource.left.toFixed(1) }}, {{ candidate.boxSource.top.toFixed(1) }}
                  - {{ candidate.boxSource.right.toFixed(1) }}, {{ candidate.boxSource.bottom.toFixed(1) }} px
                </span>
              </li>
            </ul>
            <ul v-else-if="diagnostics.candidates.length" class="debug-list">
              <li v-for="(candidate, index) in diagnostics.candidates" :key="index">
                <span class="debug-index">#{{ index + 1 }}</span>
                <span class="debug-conf">{{ formatConfidence(candidate.confidence) }}</span>
                <span class="debug-xy">
                  {{ candidate.point.x.toFixed(1) }}, {{ candidate.point.y.toFixed(1) }} px
                </span>
              </li>
            </ul>

            <p v-if="diagnostics.errors.length" class="debug-errors">
              {{ diagnostics.errors.join('; ') }}
            </p>

            <div class="sheet-actions">
              <button
                class="ghost"
                :disabled="!diagnostics"
                @click="emit('save-debug-case')"
              >
                Save debug case
              </button>
            </div>
          </template>
        </section>

        <p class="muted sheet-note">
          {{ statusDetail }} Resetting the visit keeps the calibration, so the next three darts can be
          marked on the same board.
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.play {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  gap: 8px;
}

.play--full {
  position: fixed;
  inset: 0;
  z-index: 30;
  padding: 0;
  background: #000;
  gap: 0;
}

.play-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.play-bar .status-chip {
  flex: 1 1 auto;
}

.play-error {
  flex: 0 0 auto;
  margin: 0;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--danger, #f85149);
  background: rgba(248, 81, 73, 0.12);
  color: var(--danger, #f85149);
  font-size: 0.8rem;
}

.play-review {
  flex: 0 0 auto;
  margin: 0;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid #d29922;
  background: rgba(210, 153, 34, 0.14);
  color: #e3b341;
  font-size: 0.8rem;
}

.play-body {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

.play-exit {
  position: absolute;
  top: calc(8px + env(safe-area-inset-top));
  right: calc(8px + env(safe-area-inset-right));
  z-index: 8;
  min-height: 36px;
  background: rgba(13, 17, 23, 0.85);
}

.status-chip {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--muted);
  font-size: 0.78rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ------------------------------------------------------------- bottom sheet -- */

.sheet {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 9;
  background: rgba(22, 27, 34, 0.96);
  border-top: 1px solid var(--border);
  border-radius: 14px 14px 0 0;
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.5);
  padding-bottom: env(safe-area-inset-bottom);
  backdrop-filter: blur(6px);
}

.sheet-handle {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 0;
  padding: 6px 12px 8px;
  background: transparent;
  border: none;
  border-radius: 14px 14px 0 0;
  text-align: left;
}

.sheet-grip {
  position: absolute;
  top: 4px;
  left: 50%;
  transform: translateX(-50%);
  width: 34px;
  height: 4px;
  border-radius: 999px;
  background: var(--border);
}

.sheet-peek {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex: 1 1 auto;
  padding-top: 6px;
}

.sheet-slots {
  display: flex;
  gap: 6px;
}

.slot {
  min-width: 42px;
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--dart-soft);
  color: var(--dart);
  font-weight: 700;
  font-size: 0.9rem;
  text-align: center;
}

.slot--empty {
  background: var(--surface-2);
  color: var(--muted);
}

.slot--fixed {
  border: 1px dashed var(--accent);
}

.sheet-total {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.sheet-total-label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}

.sheet-total-value {
  font-size: 1.9rem;
  font-weight: 800;
  color: var(--accent);
  line-height: 1;
}

.sheet-chevron {
  color: var(--muted);
  flex: 0 0 auto;
}

.sheet-body {
  max-height: 52dvh;
  overflow-y: auto;
  padding: 0 12px 12px;
}

.sheet-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.sheet-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
}

.sheet-row-badge {
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--dart-soft);
  color: var(--dart);
  font-weight: 700;
  font-size: 0.75rem;
}

.sheet-row-text {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
}

.sheet-row-label {
  font-size: 1.05rem;
  font-weight: 700;
}

.sheet-row-meta {
  font-size: 0.75rem;
  color: var(--muted);
}

.sheet-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.sheet-actions > button {
  flex: 1 1 auto;
}

.sheet-note {
  margin-top: 10px;
}

/* ------------------------------------------------------------ debug panel -- */

.debug {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}

.debug-title {
  margin: 0 0 8px;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}

.debug-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 10px;
  margin: 0 0 10px;
}

.debug-grid div {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  font-size: 0.76rem;
}

.debug-grid dt {
  color: var(--muted);
}

.debug-grid dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}

.debug-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 30dvh;
  overflow-y: auto;
}

.debug-list li {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  padding: 3px 0;
  font-size: 0.78rem;
  border-bottom: 1px solid var(--border);
}

.debug-index {
  width: 26px;
  flex: 0 0 auto;
  color: var(--muted);
}

.debug-conf {
  width: 48px;
  flex: 0 0 auto;
  font-weight: 700;
  color: var(--dart);
  font-variant-numeric: tabular-nums;
}

.debug-status {
  min-width: 120px;
  font-size: 0.7rem;
  font-weight: 700;
}

.debug-status--retained {
  color: #3fb950;
}

.debug-status--nms-suppressed {
  color: #f85149;
}

.debug-status--below-confidence {
  color: #d29922;
}

.debug-status--other-class-wins {
  color: #a371f7;
}

.debug-xy {
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

.debug-errors {
  margin: 8px 0 0;
  font-size: 0.78rem;
  color: var(--danger, #f85149);
}
</style>
