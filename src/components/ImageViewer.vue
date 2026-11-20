<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue';
import type { Frame } from '../camera/frame';
import type { Calibration } from '../geometry/calibration';
import { clampToImage } from '../geometry/imageCoords';
import {
  createProjection,
  imageFromDisplay,
  panBy,
  projectedRect,
  zoomAt,
  type ViewState,
} from '../geometry/viewTransform';
import { boardNumberLabels, boardRingShapes, boardWireShapes } from '../overlay/boardOverlay';
import type { Point, Size, TapperMarker } from '../types';

/**
 * FULL-SCREEN IMAGE WORKSPACE
 *
 * The single surface where the photo is viewed and edited on a phone. It owns
 * the gestures and the magnifier, and it *never* decides what a point means:
 * it emits image-pixel coordinates and the parent turns them into calibration
 * wires or dart entry points.
 *
 * Gesture contract (the part that is easy to get wrong):
 *   - one finger on empty space  -> pan (a stationary one is a tap -> `place`)
 *   - one finger on a marker     -> drag that marker (a stationary one -> `select`)
 *   - two fingers               -> pinch zoom + pan, and a tap can never fire
 * The view is a controlled prop (`v-model:view`), so the parent can preserve or
 * reset the zoom/pan between steps.
 */

interface Props {
  frame: Frame;
  /** Markers in image pixels. */
  markers: TapperMarker[];
  /** Controlled zoom/pan state. */
  view: ViewState;
  calibration?: Calibration | null;
  /** Draw the projected board wires and numbers. */
  showBoard?: boolean;
  /** Marker drawn as the current target, with a crosshair. */
  activeId?: string | null;
  /** Allow grabbing and dragging markers. */
  draggable?: boolean;
  /** Show the offset magnifier while placing or adjusting a point. */
  loupe?: boolean;
  /** Show the directional fine-adjust pad for the active marker. */
  fineAdjust?: boolean;
  hint?: string;
}

const props = withDefaults(defineProps<Props>(), {
  calibration: null,
  showBoard: false,
  activeId: null,
  draggable: true,
  loupe: true,
  fineAdjust: false,
  hint: '',
});

const emit = defineEmits<{
  place: [point: Point];
  move: [payload: { id: string; point: Point }];
  select: [id: string];
  'update:view': [view: ViewState];
}>();

/** How close a finger must be to a marker to grab it, in display px. */
const GRAB_RADIUS_PX = 30;
/** Movement beyond this (display px) turns a touch into a drag, not a tap. */
const TAP_SLOP_PX = 8;
const LOUPE_SIZE = 132;
const LOUPE_MAG = 6;
const LOUPE_GAP_PX = 20;

const MARKER_RADIUS_PX = 13;
const MARKER_STROKE_PX = 2.5;
const MARKER_FONT_PX = 15;
const NUMBER_FONT_PX = 13;

const viewportRef = ref<HTMLElement | null>(null);
const imgRef = ref<HTMLImageElement | null>(null);
const loupeCanvas = ref<HTMLCanvasElement | null>(null);

const viewportSize = ref<Size>({ width: 0, height: 0 });

const imageSize = computed<Size>(() => ({ width: props.frame.width, height: props.frame.height }));
const projection = computed(() => createProjection(props.view, imageSize.value, viewportSize.value));
const layerRect = computed(() => projectedRect(projection.value, imageSize.value));
const viewBox = computed(() => `0 0 ${props.frame.width} ${props.frame.height}`);

const layerStyle = computed<CSSProperties>(() => ({
  left: `${layerRect.value.left}px`,
  top: `${layerRect.value.top}px`,
  width: `${layerRect.value.width}px`,
  height: `${layerRect.value.height}px`,
}));

const scale = computed(() => projection.value.scale);
const markerRadius = computed(() => (scale.value > 0 ? MARKER_RADIUS_PX / scale.value : 20));
const markerStroke = computed(() => (scale.value > 0 ? MARKER_STROKE_PX / scale.value : 3));
const markerFontSize = computed(() => (scale.value > 0 ? MARKER_FONT_PX / scale.value : 22));
const numberFontSize = computed(() => (scale.value > 0 ? NUMBER_FONT_PX / scale.value : 24));

/* ------------------------------------------------------------ measuring --- */

let observer: ResizeObserver | null = null;

onMounted(() => {
  const el = viewportRef.value;
  if (!el || typeof ResizeObserver === 'undefined') return;
  observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) viewportSize.value = { width, height };
    }
    // A resize mid-gesture (rotation) leaves stale client coordinates behind.
    resetGesture();
  });
  observer.observe(el);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});

/* --------------------------------------------------------------- gesture --- */

interface PointerRecord {
  startClient: Point;
  lastClient: Point;
  role: 'pan' | 'marker';
  markerId: string | null;
  moved: boolean;
}

const pointers = new Map<number, PointerRecord>();
let gestureRect = { left: 0, top: 0 };
let wasPinch = false;
let pinchStart: { distance: number; midLocal: Point; view: ViewState } | null = null;

/** Client position of the single finger the magnifier follows, or null. */
const loupePoint = ref<Point | null>(null);

function localPoint(client: Point): Point {
  return { x: client.x - gestureRect.left, y: client.y - gestureRect.top };
}

function markerNear(imagePoint: Point): TapperMarker | null {
  let best: TapperMarker | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const s = scale.value;
  for (const marker of props.markers) {
    const distance = Math.hypot(marker.point.x - imagePoint.x, marker.point.y - imagePoint.y) * s;
    if (distance <= GRAB_RADIUS_PX && distance < bestDistance) {
      best = marker;
      bestDistance = distance;
    }
  }
  return best;
}

function midLocalOf(a: Point, b: Point): Point {
  const la = localPoint(a);
  const lb = localPoint(b);
  return { x: (la.x + lb.x) / 2, y: (la.y + lb.y) / 2 };
}

function resetGesture(): void {
  pointers.clear();
  pinchStart = null;
  wasPinch = false;
  loupePoint.value = null;
}

function updateLoupe(): void {
  if (!props.loupe || wasPinch || pointers.size !== 1) {
    loupePoint.value = null;
    return;
  }
  const record = [...pointers.values()][0];
  // While panning the magnifier would just be noise; while placing or dragging it is the point.
  loupePoint.value = record.role === 'marker' || !record.moved ? { ...record.lastClient } : null;
}

function onPointerDown(event: PointerEvent): void {
  const el = viewportRef.value;
  if (!el) return;

  if (pointers.size === 0) {
    const rect = el.getBoundingClientRect();
    gestureRect = { left: rect.left, top: rect.top };
    wasPinch = false;
    pinchStart = null;
  }

  const client = { x: event.clientX, y: event.clientY };
  const record: PointerRecord = {
    startClient: client,
    lastClient: client,
    role: 'pan',
    markerId: null,
    moved: false,
  };

  if (pointers.size === 0 && props.draggable) {
    const hit = markerNear(imageFromDisplay(localPoint(client), projection.value));
    if (hit) {
      record.role = 'marker';
      record.markerId = hit.id;
    }
  }

  pointers.set(event.pointerId, record);

  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    wasPinch = true;
    pinchStart = {
      distance: Math.max(1, Math.hypot(a.lastClient.x - b.lastClient.x, a.lastClient.y - b.lastClient.y)),
      midLocal: midLocalOf(a.lastClient, b.lastClient),
      view: props.view,
    };
  }
  updateLoupe();

  if (typeof el.setPointerCapture === 'function') el.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function applyPinch(): void {
  if (!pinchStart || pointers.size < 2) return;
  const [a, b] = [...pointers.values()];
  const distance = Math.max(
    1,
    Math.hypot(a.lastClient.x - b.lastClient.x, a.lastClient.y - b.lastClient.y),
  );
  const mid = midLocalOf(a.lastClient, b.lastClient);
  const factor = distance / pinchStart.distance;
  const zoomed = zoomAt(
    pinchStart.view,
    imageSize.value,
    viewportSize.value,
    pinchStart.midLocal,
    pinchStart.view.zoom * factor,
  );
  // The fingers' midpoint can also drift, so allow a two-finger pan on top.
  emit(
    'update:view',
    panBy(zoomed, imageSize.value, viewportSize.value, mid.x - pinchStart.midLocal.x, mid.y - pinchStart.midLocal.y),
  );
}

function onPointerMove(event: PointerEvent): void {
  const record = pointers.get(event.pointerId);
  if (!record) return;

  const client = { x: event.clientX, y: event.clientY };
  const prev = record.lastClient;
  record.lastClient = client;

  if (pointers.size >= 2) {
    applyPinch();
    updateLoupe();
    event.preventDefault();
    return;
  }

  if (Math.hypot(client.x - record.startClient.x, client.y - record.startClient.y) > TAP_SLOP_PX) {
    record.moved = true;
  }

  if (record.role === 'marker' && record.markerId) {
    emit('move', {
      id: record.markerId,
      point: clampToImage(imageFromDisplay(localPoint(client), projection.value), imageSize.value),
    });
  } else {
    const dx = client.x - prev.x;
    const dy = client.y - prev.y;
    if (dx !== 0 || dy !== 0) {
      emit('update:view', panBy(props.view, imageSize.value, viewportSize.value, dx, dy));
    }
  }

  updateLoupe();
  event.preventDefault();
}

function onPointerUp(event: PointerEvent): void {
  const el = viewportRef.value;
  if (el && typeof el.releasePointerCapture === 'function' && el.hasPointerCapture(event.pointerId)) {
    el.releasePointerCapture(event.pointerId);
  }

  const record = pointers.get(event.pointerId);
  if (!record) return;
  pointers.delete(event.pointerId);

  if (pointers.size >= 1) {
    // A pinch that shrinks to one finger must not become a stray tap or pan jump.
    if (wasPinch) {
      for (const remaining of pointers.values()) {
        remaining.role = 'pan';
        remaining.markerId = null;
        remaining.moved = true;
        remaining.startClient = remaining.lastClient;
      }
    }
    pinchStart = null;
    updateLoupe();
    event.preventDefault();
    return;
  }

  const client = { x: event.clientX, y: event.clientY };
  const role = record.role;
  const markerId = record.markerId;
  const isTap = !wasPinch && !record.moved;
  const imagePoint = clampToImage(imageFromDisplay(localPoint(client), projection.value), imageSize.value);

  resetGesture();

  if (!isTap) return;
  if (role === 'marker' && markerId) emit('select', markerId);
  else emit('place', imagePoint);
  event.preventDefault();
}

function onPointerCancel(event: PointerEvent): void {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  if (pointers.size === 0) {
    resetGesture();
  } else {
    pinchStart = null;
    updateLoupe();
  }
}

/* ---------------------------------------------------------------- loupe --- */

const loupeVisible = computed(() => props.loupe && loupePoint.value !== null && scale.value > 0);

const loupeStyle = computed<CSSProperties>(() => {
  const client = loupePoint.value;
  if (!client) return { display: 'none' };
  const local = localPoint(client);
  const maxLeft = Math.max(0, viewportSize.value.width - LOUPE_SIZE);
  const left = Math.min(Math.max(local.x - LOUPE_SIZE / 2, 0), maxLeft);
  let top = local.y - LOUPE_GAP_PX - LOUPE_SIZE;
  if (top < 0) top = local.y + LOUPE_GAP_PX;
  const maxTop = Math.max(0, viewportSize.value.height - LOUPE_SIZE);
  return { left: `${left}px`, top: `${Math.min(Math.max(top, 0), maxTop)}px` };
});

function drawLoupe(): void {
  const canvas = loupeCanvas.value;
  const img = imgRef.value;
  const client = loupePoint.value;
  const proj = projection.value;
  if (!canvas || !img || !client || !(proj.scale > 0)) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const span = LOUPE_SIZE / (proj.scale * LOUPE_MAG);
  const centre = imageFromDisplay(localPoint(client), proj);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
  ctx.drawImage(
    img,
    centre.x - span / 2,
    centre.y - span / 2,
    span,
    span,
    0,
    0,
    LOUPE_SIZE,
    LOUPE_SIZE,
  );

  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(LOUPE_SIZE / 2, 0);
  ctx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE);
  ctx.moveTo(0, LOUPE_SIZE / 2);
  ctx.lineTo(LOUPE_SIZE, LOUPE_SIZE / 2);
  ctx.stroke();
}

watch([loupePoint, projection], async () => {
  await nextTick();
  drawLoupe();
});

// The photo can finish decoding after the first loupe draw; redraw once it has.
watch(
  () => props.frame.url,
  async () => {
    await nextTick();
    drawLoupe();
  },
);

/* -------------------------------------------------------- fine adjust --- */

/** Nudge distances offered to the user, in DISPLAY pixels. */
const NUDGE_STEPS = [1, 4, 16] as const;
const nudgeStep = ref<number>(4);

const NUDGE_DIRECTIONS: ReadonlyArray<{ key: string; dx: number; dy: number; label: string; name: string }> = [
  { key: 'nw', dx: -1, dy: -1, label: '\u2196', name: 'up and left' },
  { key: 'n', dx: 0, dy: -1, label: '\u2191', name: 'up' },
  { key: 'ne', dx: 1, dy: -1, label: '\u2197', name: 'up and right' },
  { key: 'w', dx: -1, dy: 0, label: '\u2190', name: 'left' },
  { key: 'e', dx: 1, dy: 0, label: '\u2192', name: 'right' },
  { key: 'sw', dx: -1, dy: 1, label: '\u2199', name: 'down and left' },
  { key: 's', dx: 0, dy: 1, label: '\u2193', name: 'down' },
  { key: 'se', dx: 1, dy: 1, label: '\u2198', name: 'down and right' },
];

const nudgeTarget = computed<TapperMarker | null>(() => {
  if (!props.fineAdjust || !props.activeId) return null;
  return props.markers.find((m) => m.id === props.activeId) ?? null;
});

/**
 * Move the active marker by a whole number of DISPLAY pixels, so a nudge always
 * moves the point by the same apparent amount no matter how far the image is
 * zoomed in. The emitted coordinate stays in source-image pixels.
 */
function nudge(dx: number, dy: number): void {
  const marker = nudgeTarget.value;
  if (!marker) return;
  const s = scale.value > 0 ? scale.value : 1;
  emit('move', {
    id: marker.id,
    point: clampToImage(
      { x: marker.point.x + (dx * nudgeStep.value) / s, y: marker.point.y + (dy * nudgeStep.value) / s },
      imageSize.value,
    ),
  });
}

/* -------------------------------------------------------------- overlay --- */

const ringShapes = computed(() =>
  props.showBoard && props.calibration ? boardRingShapes(props.calibration) : [],
);
const wireShapes = computed(() =>
  props.showBoard && props.calibration ? boardWireShapes(props.calibration) : [],
);
const numberLabels = computed(() =>
  props.showBoard && props.calibration ? boardNumberLabels(props.calibration) : [],
);

function markerClass(marker: TapperMarker): Record<string, boolean> {
  return {
    'marker-ring--dart': marker.kind === 'dart',
    'marker-ring--pending': marker.kind === 'calibration',
    'marker-ring--active': marker.id === props.activeId,
  };
}
</script>

<template>
  <div class="viewer">
    <p v-if="hint" class="viewer-hint">{{ hint }}</p>

    <div
      ref="viewportRef"
      class="viewport"
      role="application"
      aria-label="Board image. Pinch to zoom, drag to pan, tap to place the point, drag the marker to adjust it."
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @contextmenu.prevent
    >
      <div class="layer" :style="layerStyle">
        <img
          ref="imgRef"
          class="photo"
          :src="frame.url"
          :alt="`Board photo, ${frame.width} by ${frame.height} pixels`"
          draggable="false"
          @load="drawLoupe"
        />

        <svg
          class="overlay"
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
              :r="marker.id === activeId ? markerRadius * 1.35 : markerRadius"
              :stroke-width="markerStroke"
              class="marker-ring"
              :class="markerClass(marker)"
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

        <svg
          v-if="activeId && markers.some((m) => m.id === activeId)"
          class="crosshair-layer"
          :viewBox="viewBox"
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <template v-for="marker in markers.filter((m) => m.id === activeId)" :key="marker.id">
            <line
              :x1="marker.point.x - 22 / (scale || 1)"
              :y1="marker.point.y"
              :x2="marker.point.x + 22 / (scale || 1)"
              :y2="marker.point.y"
              class="crosshair"
              vector-effect="non-scaling-stroke"
            />
            <line
              :x1="marker.point.x"
              :y1="marker.point.y - 22 / (scale || 1)"
              :x2="marker.point.x"
              :y2="marker.point.y + 22 / (scale || 1)"
              class="crosshair"
              vector-effect="non-scaling-stroke"
            />
          </template>
        </svg>
      </div>

      <div v-if="loupeVisible" class="loupe" :style="loupeStyle">
        <canvas ref="loupeCanvas" :width="LOUPE_SIZE" :height="LOUPE_SIZE"></canvas>
      </div>

      <!--
        Fine adjust. `pointerdown.stop` (and friends) keep the pad's touches out
        of the viewport gesture handler, so tapping a nudge never pans the photo
        or places a marker.
      -->
      <div
        v-if="nudgeTarget"
        class="nudge"
        role="group"
        aria-label="Fine adjust the active point"
        @pointerdown.stop
        @pointermove.stop
        @pointerup.stop
        @pointercancel.stop
      >
        <div class="nudge-steps" role="group" aria-label="Nudge step in pixels">
          <button
            v-for="step in NUDGE_STEPS"
            :key="step"
            type="button"
            class="nudge-step"
            :class="{ 'is-active': nudgeStep === step }"
            :aria-pressed="nudgeStep === step"
            @click.stop="nudgeStep = step"
          >
            {{ step }}
          </button>
        </div>

        <div class="nudge-pad">
          <button
            v-for="dir in NUDGE_DIRECTIONS"
            :key="dir.key"
            type="button"
            class="nudge-key"
            :class="`nudge-key--${dir.key}`"
            :aria-label="`Nudge ${dir.name} by ${nudgeStep} pixels`"
            @click.stop="nudge(dir.dx, dir.dy)"
          >
            {{ dir.label }}
          </button>
        </div>
      </div>

      <slot :scale="scale" :zoom="view.zoom" />
    </div>
  </div>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
}

.viewer-hint {
  margin: 0 0 6px;
  font-size: 0.82rem;
  color: var(--muted);
}

.viewport {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  background: #000;
  border-radius: 10px;
  /* The workspace swallows touch gestures; the rest of the page keeps the
     browser's default behaviour (page zoom is NOT disabled globally). */
  touch-action: none;
  overscroll-behavior: contain;
  /* A long press or force touch must not open the native callout ("Save
     image", "Copy", a peek preview) or start a text selection - they would
     steal the gesture and, on iOS, show the system magnifier on top of ours.
     `touch-action` does not cover this; it is a callout/selection behaviour. */
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}

.layer {
  position: absolute;
  transform-origin: 0 0;
  pointer-events: none;
}

.photo,
.overlay,
.crosshair-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.photo {
  object-fit: fill;
  /* Never the hit target: the photo is a texture, not a control. This keeps
     iOS from treating the long press as "press on an image", and every touch
     is delivered to `.viewport`, which owns the gesture handlers. */
  pointer-events: none;
  user-select: none;
  -webkit-user-drag: none;
  -webkit-touch-callout: none;
}

.overlay,
.crosshair-layer {
  pointer-events: none;
}

.crosshair {
  stroke: rgba(255, 255, 255, 0.9);
  stroke-width: 1.5;
}

.loupe {
  position: absolute;
  width: 132px;
  height: 132px;
  border-radius: 50%;
  overflow: hidden;
  border: 2px solid var(--accent);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.65);
  pointer-events: none;
  background: #000;
  z-index: 5;
}

.loupe canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.nudge {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: 14px;
  background: rgba(13, 17, 23, 0.82);
  border: 1px solid var(--border);
  backdrop-filter: blur(3px);
  z-index: 6;
}

.nudge-steps {
  display: flex;
  gap: 4px;
}

.nudge-step {
  min-height: 30px;
  min-width: 30px;
  padding: 0 6px;
  font-size: 0.72rem;
  border-radius: 8px;
  background: transparent;
}

.nudge-step.is-active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.nudge-pad {
  display: grid;
  grid-template-columns: repeat(3, 40px);
  grid-template-rows: repeat(3, 40px);
  gap: 2px;
}

.nudge-key {
  min-height: 0;
  min-width: 0;
  padding: 0;
  font-size: 1rem;
  line-height: 1;
  border-radius: 9px;
  background: rgba(31, 38, 48, 0.9);
}

.nudge-key--nw { grid-area: 1 / 1; }
.nudge-key--n { grid-area: 1 / 2; }
.nudge-key--ne { grid-area: 1 / 3; }
.nudge-key--w { grid-area: 2 / 1; }
.nudge-key--e { grid-area: 2 / 3; }
.nudge-key--sw { grid-area: 3 / 1; }
.nudge-key--s { grid-area: 3 / 2; }
.nudge-key--se { grid-area: 3 / 3; }
</style>
