<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  CORRECTABLE_SEGMENTS,
  MULTIPLIERS,
  isValidSelection,
  multiplierOf,
  scoreFromSelection,
  type DartEntry,
  type DartScore,
  type Multiplier,
  type SegmentId,
} from '../scoring/score';

/**
 * Direct score correction.
 *
 * This deliberately never touches the marked coordinate: a dart that was scored
 * wrongly is fixed by choosing the segment and multiplier it actually hit. The
 * user is never asked to re-position an image point just to change a number.
 *
 * The chosen score is applied as an OVERRIDE, kept apart from the geometric
 * score of the point, so the two can always be told apart afterwards.
 */

interface Props {
  entry: DartEntry;
  index: number;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  apply: [score: DartScore];
  clear: [];
  cancel: [];
}>();

const MULTIPLIER_LABELS: Record<Multiplier, string> = {
  1: 'Single',
  2: 'Double',
  3: 'Treble',
};

const segment = ref<SegmentId>(props.entry.score?.segment ?? 'MISS');
const multiplier = ref<Multiplier>(multiplierOf(props.entry.score));

function segmentLabel(value: SegmentId): string {
  if (value === 'BULL') return 'Bull';
  if (value === 'MISS') return 'Miss';
  return String(value);
}

function setSegment(value: SegmentId): void {
  segment.value = value;
  // Treble does not exist for the bull, nor any multiplier for a miss.
  if (!isValidSelection(value, multiplier.value)) multiplier.value = 1;
}

const preview = computed(() => scoreFromSelection(segment.value, multiplier.value));
</script>

<template>
  <div class="fix-backdrop" @click.self="emit('cancel')">
    <div class="fix" role="dialog" aria-modal="true" :aria-label="`Fix score for dart ${index + 1}`">
      <header class="fix-head">
        <strong>Fix score - dart {{ index + 1 }}</strong>
        <button class="tiny ghost" @click="emit('cancel')">Close</button>
      </header>

      <p class="muted fix-note">
        This changes the score only. The marked point stays exactly where it is, and the correction is
        kept separate from it.
      </p>

      <div class="fix-segments" role="group" aria-label="Segment">
        <button
          v-for="value in CORRECTABLE_SEGMENTS"
          :key="String(value)"
          class="fix-seg"
          :class="{ 'is-active': value === segment, 'fix-seg--wide': typeof value === 'string' }"
          :aria-pressed="value === segment"
          @click="setSegment(value)"
        >
          {{ segmentLabel(value) }}
        </button>
      </div>

      <div class="fix-multipliers" role="group" aria-label="Multiplier">
        <button
          v-for="m in MULTIPLIERS"
          :key="m"
          class="fix-mult"
          :class="{ 'is-active': m === multiplier }"
          :disabled="!isValidSelection(segment, m)"
          :aria-pressed="m === multiplier"
          @click="multiplier = m"
        >
          {{ MULTIPLIER_LABELS[m] }}
        </button>
      </div>

      <div class="fix-preview">
        <span class="muted">Result</span>
        <span class="fix-preview-score">{{ preview.score }}</span>
        <span class="fix-preview-label">{{ preview.label }}</span>
      </div>

      <div class="fix-actions">
        <button v-if="entry.corrected" class="ghost" @click="emit('clear')">Clear correction</button>
        <button class="primary grow" @click="emit('apply', preview)">Apply score</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fix-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  padding: 8px;
  padding-bottom: calc(8px + env(safe-area-inset-bottom));
}

.fix {
  width: 100%;
  max-width: 520px;
  max-height: 88dvh;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 12px;
}

.fix-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.fix-note {
  margin: 6px 0 10px;
}

.fix-segments {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 5px;
}

.fix-seg {
  min-height: 44px;
  padding: 0;
  font-size: 0.95rem;
  font-weight: 600;
  border-radius: 9px;
}

.fix-seg--wide {
  grid-column: span 2;
  font-size: 0.82rem;
}

.fix-seg.is-active,
.fix-mult.is-active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}

.fix-multipliers {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5px;
  margin-top: 8px;
}

.fix-mult {
  min-height: 44px;
  font-size: 0.86rem;
}

.fix-preview {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 12px 0;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.fix-preview-score {
  font-size: 2rem;
  font-weight: 800;
  color: var(--accent);
  line-height: 1;
}

.fix-preview-label {
  font-weight: 700;
}

.fix-actions {
  display: flex;
  gap: 8px;
}
</style>
