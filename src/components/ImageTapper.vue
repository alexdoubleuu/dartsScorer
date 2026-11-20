<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue';
import type { Frame } from '../camera/frame';
import type { Calibration } from '../geometry/calibration';
import { clampToImage, displayToImage, imageDistanceToDisplay } from '../geometry/imageCoords';
import { boardNumberLabels, boardRingShapes, boardWireShapes } from '../overlay/boardOverlay';
import type { Point, RectLike, Size, TapperMarker } from '../types';

/**
 * The image stage: shows the frozen frame, the board overlay and the editable
 * markers, and turns pointer input into IMAGE PIXEL coordinates.
 *
 * Coordinate systems, in one place:
 *   - image pixels   - what this component emits and what `markers` contain
 *   - display pixels - what `getBoundingClientRect` and pointer events use; the
 *                      conversion goes through `displayToImage`, which knows
 *                      about the stage's fitted, letterboxed rect
 *   - SVG units      - the overlay's `viewBox` is the image, so the overlay
 *                      needs no conversion at all and cannot drift from the
 *                      markers when the preview is resized
 */

interface Props {
  frame: Frame;
  markers: TapperMarker[];
  calibration?: Calibration | null;
  showBoard?: boolean;
  hint?: string;
}

const props = withDefaults(defineProps<Props>(), {
  calibration: null,
  showBoard: false,
  hint: '',
});

const emit = defineEmits<{
  place: [point: Point];
  move: [payload: { id: string; point: Point }];
  commit: [];
  select: [id: string];
}>();

/** How close a pointer must be to an existing marker to grab it, in display px. */
const GRAB_RADIUS_PX = 26;
const LOUPE_SIZE = 128;
/** The loupe magnifies the stage by this factor. */
const LOUPE_MAG = 5;

const stageRef = ref<HTMLElement | null>(null);
const tapperRef = ref<HTMLElement | null>(null);
const loupeCanvas = ref<HTMLCanvasElement | null>(null);

const imageSize = computed<Size>(() => ({ width: props.frame.width, height: props.frame.height }));
const viewBox = computed(() => `0 0 ${props.frame.width} ${props.frame.height}`);
const stageStyle = computed<CSSProperties>(() => ({
  width: '100%',
  aspectRatio: `${props.frame.width} / ${props.frame.height}`,
}));

/* ------------------------------------------------------------- measuring --- */

const stageWidth = ref(0);
let observer: ResizeObserver | null = null;

onMounted(() => {
  const el = stageRef.value;
  if (!el || typeof ResizeObserver === 'undefined') return;
  observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.contentRect.width > 0) stageWidth.value = entry.contentRect.width;
    }
  });
  observer.observe(el);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

/** Display pixels per image pixel. 0 until the first measurement lands. */
const displayScale = computed(() => {
  const width = imageSize.value.width;
  return width > 0 && stageWidth.value > 0 ? stageWidth.value / width : 0;
});

/** Marker sizes are constant on screen, so they must be converted to image units. */
const markerRadius = computed(() => (displayScale.value > 0 ? 13 / displayScale.value : 20));
const markerFontSize = computed(() => (displayScale.value > 0 ? 15 / displayScale.value : 22));
const numberFontSize = computed(() => (displayScale.value > 0 ? 13 / displayScale.value : 24));
const markerStrokeWidth = computed(() => (displayScale.value > 0 ? 2.5 / displayScale.value : 3));

/* --------------------------------------------------------------- pointer --- */

const activePointer = ref<number | null>(null);
const activeBox = ref<RectLike | null>(null);
const pointerClient = ref<Point | null>(null);
const tapperBox = ref<RectLike | null>(null);
/** Current pointer position in image coordinates, while the pointer is down. */
const hover = ref<Point | null>(null);
const dragId = ref<string | null>(null);
const dragMoved = ref(false);

function markerNear(imagePoint: Point, box: RectLike): TapperMarker | null {
  let best: TapperMarker | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const marker of props.markers) {
    const distance = imageDistanceToDisplay(marker.point, imagePoint, box, imageSize.value);
    if (distance <= GRAB_RADIUS_PX && distance < bestDistance) {
      best = marker;
      bestDistance = distance;
    }
  }
  return best;
}

function onPointerDown(event: PointerEvent): void {
  if (activePointer.value !== null) return;
  const stage = stageRef.value;
  if (!stage) return;

  const box = stage.getBoundingClientRect();
  activeBox.value = box;
  tapperBox.value = tapperRef.value?.getBoundingClientRect() ?? null;
  pointerClient.value = { x: event.clientX, y: event.clientY };

  const imagePoint = displayToImage(pointerClient.value, box, imageSize.value);
  hover.value = imagePoint;
  dragMoved.value = false;

  activePointer.value = event.pointerId;
  dragId.value = markerNear(imagePoint, box)?.id ?? null;

  // Capture on the element that owns these handlers. Pointer capture retargets
  // move/up events to the capturing element, so capturing on an ancestor (the
  // stage) would stop this element from ever seeing the pointer up - and the
  // tap would be lost.
  const hit = event.currentTarget as HTMLElement | null;
  if (hit && typeof hit.setPointerCapture === 'function') hit.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  if (activePointer.value !== event.pointerId) return;
  const box = activeBox.value;
  if (!box) return;

  const client = { x: event.clientX, y: event.clientY };
  pointerClient.value = client;
  const imagePoint = displayToImage(client, box, imageSize.value);
  hover.value = imagePoint;

  if (dragId.value) {
    dragMoved.value = true;
    emit('move', { id: dragId.value, point: clampToImage(imagePoint, imageSize.value) });
  }
  event.preventDefault();
}

function onPointerUp(event: PointerEvent): void {
  if (activePointer.value !== event.pointerId) return;

  const box = activeBox.value;
  const id = dragId.value;
  const moved = dragMoved.value;

  activePointer.value = null;
  activeBox.value = null;
  pointerClient.value = null;
  hover.value = null;
  dragId.value = null;
  dragMoved.value = false;

  const hit = event.currentTarget as HTMLElement | null;
  if (hit && typeof hit.releasePointerCapture === 'function') {
    hit.releasePointerCapture(event.pointerId);
  }
  if (!box) return;

  const imagePoint = clampToImage(
    displayToImage({ x: event.clientX, y: event.clientY }, box, imageSize.value),
    imageSize.value,
  );

  if (id) {
    // A tap on an existing marker selects it; a drag has already emitted `move`.
    if (moved) emit('commit');
    else emit('select', id);
    return;
  }
  emit('place', imagePoint);
}

function onPointerCancel(event: PointerEvent): void {
  if (activePointer.value !== event.pointerId) return;
  activePointer.value = null;
  activeBox.value = null;
  pointerClient.value = null;
  hover.value = null;
  dragId.value = null;
  dragMoved.value = false;
}

/* ----------------------------------------------------------------- loupe --- */

const loupeStyle = computed<CSSProperties>(() => {
  const client = pointerClient.value;
  const box = tapperBox.value;
  if (!client || !box) return { display: 'none' };

  const offset = 58;
  const relativeX = client.x - box.left;
  const relativeY = client.y - box.top;
  let top = relativeY - offset - LOUPE_SIZE;
  if (top < 0) top = relativeY + offset;
  const left = Math.min(Math.max(relativeX + offset, 0), Math.max(0, box.width - LOUPE_SIZE));
  const maxTop = Math.max(0, box.height - LOUPE_SIZE);

  return {
    left: `${left}px`,
    top: `${Math.min(Math.max(top, 0), maxTop)}px`,
  };
});

const sourceImage = ref<HTMLImageElement | null>(null);

watch(
  () => props.frame.url,
  (url) => {
    const image = new Image();
    image.onload = () => {
      sourceImage.value = image;
    };
    image.src = url;
  },
  { immediate: true },
);

function drawLoupe(): void {
  const canvas = loupeCanvas.value;
  const image = sourceImage.value;
  const point = hover.value;
  const scale = displayScale.value;
  if (!canvas || !image || !point || scale <= 0) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const span = LOUPE_SIZE / (scale * LOUPE_MAG);
  const sx = point.x - span / 2;
  const sy = point.y - span / 2;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
  ctx.drawImage(image, sx, sy, span, span, 0, 0, LOUPE_SIZE, LOUPE_SIZE);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(LOUPE_SIZE / 2, 0);
  ctx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE);
  ctx.moveTo(0, LOUPE_SIZE / 2);
  ctx.lineTo(LOUPE_SIZE, LOUPE_SIZE / 2);
  ctx.stroke();
}

watch(hover, async () => {
  await nextTick();
  drawLoupe();
});

watch(sourceImage, () => drawLoupe());

/* ---------------------------------------------------------------- overlay -- */

const ringShapes = computed(() =>
  props.showBoard && props.calibration ? boardRingShapes(props.calibration) : [],
);
const wireShapes = computed(() =>
  props.showBoard && props.calibration ? boardWireShapes(props.calibration) : [],
);
const numberLabels = computed(() =>
  props.showBoard && props.calibration ? boardNumberLabels(props.calibration) : [],
);
</script>

<template>
  <div class="tapper" ref="tapperRef">
    <p v-if="hint" class="muted tapper-hint">{{ hint }}</p>

    <div class="stage" ref="stageRef" :style="stageStyle">
      <img class="stage-img" :src="frame.url" :alt="`Frozen frame, ${frame.width} by ${frame.height} pixels`" />

      <svg
        class="stage-overlay"
        :viewBox="viewBox"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <path
          v-for="shape in ringShapes"
          :key="shape.key"
          :d="shape.d"
          class="board-line"
          :class="{ 'board-line--outer': shape.emphasis === 'strong' }"
          vector-effect="non-scaling-stroke"
        />
        <path
          v-for="shape in wireShapes"
          :key="shape.key"
          :d="shape.d"
          class="board-line"
          vector-effect="non-scaling-stroke"
        />
        <text
          v-for="label in numberLabels"
          :key="label.key"
          :x="label.point.x"
          :y="label.point.y"
          :font-size="numberFontSize"
          class="board-number"
        >
          {{ label.number }}
        </text>

        <g v-for="marker in markers" :key="marker.id">
          <circle
            :cx="marker.point.x"
            :cy="marker.point.y"
            :r="marker.selected ? markerRadius * 1.35 : markerRadius"
            :stroke-width="markerStrokeWidth"
            class="marker-ring"
            :class="{
              'marker-ring--dart': marker.kind === 'dart',
              'marker-ring--pending': marker.kind === 'calibration',
            }"
          />
          <text
            :x="marker.point.x"
            :y="marker.point.y"
            :font-size="markerFontSize"
            class="marker-label"
          >
            {{ marker.label }}
          </text>
        </g>
      </svg>

      <div
        class="stage-hit"
        role="application"
        aria-label="Dartboard image. Tap to place a point, drag an existing point to move it."
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerCancel"
      ></div>

      <div v-if="hover" class="loupe" :style="loupeStyle">
        <canvas ref="loupeCanvas" :width="LOUPE_SIZE" :height="LOUPE_SIZE"></canvas>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tapper-hint {
  margin-bottom: 6px;
}
</style>
