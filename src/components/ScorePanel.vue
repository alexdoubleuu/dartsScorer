<script setup lang="ts">
import { computed } from 'vue';
import type { RingId } from '../board/boardModel';
import type { DartEntry } from '../scoring/score';
import { sumScores } from '../scoring/score';

/**
 * Dart list and total. Purely presentational: it never computes a score, it
 * renders the scores produced by `scoreImagePoint`.
 */

interface Props {
  entries: DartEntry[];
  maxDarts: number;
  selectedId?: string | null;
}

const props = withDefaults(defineProps<Props>(), { selectedId: null });

const emit = defineEmits<{
  select: [id: string];
  remove: [id: string];
  undo: [];
  reset: [];
}>();

const RING_TEXT: Record<RingId, string> = {
  'inner-bull': 'Inner bull',
  'outer-bull': 'Outer bull',
  'inner-single': 'Inner single',
  treble: 'Treble, x3',
  'outer-single': 'Outer single',
  double: 'Double, x2',
  'off-board': 'Off the board',
};

const total = computed(() => sumScores(props.entries.flatMap((e) => (e.score ? [e.score] : []))));
const unscorable = computed(() => props.entries.filter((e) => e.score === null).length);
</script>

<template>
  <div class="stack">
    <p class="muted">
      {{ entries.length }} of {{ maxDarts }} darts marked. Each point below was entered by hand.
    </p>

    <ul v-if="entries.length > 0" class="score-list">
      <li v-for="(entry, index) in entries" :key="entry.id" class="score-item">
        <span class="score-badge">{{ index + 1 }}</span>

        <span class="grow">
          <template v-if="entry.score">
            <span class="score-label">{{ entry.score.label }}</span>
            <span class="muted"> - {{ RING_TEXT[entry.score.ring] }}, {{ entry.score.score }} points</span>
          </template>
          <template v-else>
            <span class="score-label">Unscorable</span>
            <span class="muted"> - this point maps to infinity. Move or remove it.</span>
          </template>
        </span>

        <button
          class="tiny"
          :class="{ primary: entry.id === selectedId }"
          @click="emit('select', entry.id)"
        >
          {{ entry.id === selectedId ? 'Selected' : 'Move' }}
        </button>
        <button class="tiny danger" @click="emit('remove', entry.id)">Remove</button>
      </li>
    </ul>

    <p v-else class="muted">No darts marked yet.</p>

    <div class="score-total">
      <span>{{ entries.length === 1 ? 'Dart score' : 'Three-dart total' }}</span>
      <span class="score-total-number score-total-number--large">{{ total }}</span>
    </div>

    <p v-if="unscorable > 0" class="muted">
      {{ unscorable }} point(s) could not be scored and are excluded from the total.
    </p>

    <div class="row row--end">
      <button class="ghost" :disabled="entries.length === 0" @click="emit('undo')">Undo last point</button>
      <button class="danger" :disabled="entries.length === 0" @click="emit('reset')">
        Reset dart points
      </button>
    </div>

    <p class="muted">Resetting the dart points keeps the calibration, so you can score the next visit.</p>
  </div>
</template>
