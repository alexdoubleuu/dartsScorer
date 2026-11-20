<script setup lang="ts">
import {
  BOARD_MM,
  SEGMENT_ANGLE_DEG,
  SEGMENT_HALF_ANGLE_DEG,
  SEGMENT_ORDER_CLOCKWISE,
  boardPointFromPolar,
  wedgeCentreAngleDeg,
} from '../board/boardModel';
import { CALIBRATION_REFS } from '../geometry/calibration';

/**
 * A top-down schematic of a standard steel-tip board showing exactly where the
 * four calibration taps go.
 *
 * This drawing is deliberately a *plan view* (no perspective) built directly
 * from the verified board model in `boardModel.ts`, so the positions shown here
 * are the same geometry the scoring code uses. Tap target 1 is drawn where the
 * 20/1 wire crosses the OUTER edge of the double ring, and so on round.
 */

const VIEW = 220;
const CENTRE = VIEW / 2;
/** SVG units per normalised board radius (r = 1.0 at 170 mm). */
const UNIT = 78;
/** Radius at which the printed numbers sit (middle of the number ring). */
const NUMBER_RADIUS = 1.16;

/** Board space -> SVG space. SVG y grows downwards, board +Y points at the 20. */
function svgPoint(radius: number, angleFromTopClockwiseDeg: number): { x: number; y: number } {
  const p = boardPointFromPolar(radius, angleFromTopClockwiseDeg);
  return { x: CENTRE + p.x * UNIT, y: CENTRE - p.y * UNIT };
}

function ringRadius(radiusMm: number): number {
  return (radiusMm / BOARD_MM.doubleOuterRadius) * UNIT;
}

const rings = [
  { key: 'double-outer', r: ringRadius(BOARD_MM.doubleOuterRadius), strong: true },
  { key: 'double-inner', r: ringRadius(BOARD_MM.doubleInnerRadius), strong: false },
  { key: 'treble-outer', r: ringRadius(BOARD_MM.trebleOuterRadius), strong: false },
  { key: 'treble-inner', r: ringRadius(BOARD_MM.trebleInnerRadius), strong: false },
  { key: 'outer-bull', r: ringRadius(BOARD_MM.outerBullRadius), strong: false },
  { key: 'inner-bull', r: ringRadius(BOARD_MM.innerBullRadius), strong: false },
];

const wires = Array.from({ length: SEGMENT_ORDER_CLOCKWISE.length }, (_, i) => {
  const angle = SEGMENT_HALF_ANGLE_DEG + i * SEGMENT_ANGLE_DEG;
  return { key: `wire-${i}`, a: svgPoint(1, angle), b: svgPoint(0, angle) };
});

const numbers = SEGMENT_ORDER_CLOCKWISE.map((number, i) => ({
  key: `number-${i}`,
  number,
  ...svgPoint(NUMBER_RADIUS, wedgeCentreAngleDeg(i)),
}));

/** The four tap targets, numbered in tap order. */
const targets = CALIBRATION_REFS.map((ref, i) => ({
  key: ref.id,
  index: i + 1,
  label: ref.label,
  hint: ref.hint,
  ...svgPoint(1, ref.angleFromTopClockwiseDeg),
}));
</script>

<template>
  <figure class="schematic">
    <svg :viewBox="`0 0 ${VIEW} ${VIEW}`" role="img" aria-label="Where to tap the four calibration points">
      <circle :cx="CENTRE" :cy="CENTRE" :r="ringRadius(BOARD_MM.doubleOuterRadius)" class="schematic-board" />

      <circle
        v-for="ring in rings"
        :key="ring.key"
        :cx="CENTRE"
        :cy="CENTRE"
        :r="ring.r"
        class="board-line"
        :class="{ 'board-line--outer': ring.strong }"
      />

      <line
        v-for="wire in wires"
        :key="wire.key"
        :x1="wire.b.x"
        :y1="wire.b.y"
        :x2="wire.a.x"
        :y2="wire.a.y"
        class="board-line"
      />

      <text v-for="n in numbers" :key="n.key" :x="n.x" :y="n.y" class="board-number">{{ n.number }}</text>

      <g v-for="t in targets" :key="t.key">
        <circle :cx="t.x" :cy="t.y" r="7" class="schematic-target" />
        <line :x1="t.x - 10" :y1="t.y" :x2="t.x + 10" :y2="t.y" class="schematic-target-cross" />
        <line :x1="t.x" :y1="t.y - 10" :x2="t.x" :y2="t.y + 10" class="schematic-target-cross" />
        <text :x="t.x" :y="t.y" class="schematic-target-index">{{ t.index }}</text>
      </g>
    </svg>

    <figcaption>
      <p class="muted">
        Plan view of a standard steel-tip board. Tap the four red crosses <strong>in order 1 to 4</strong>,
        each where the radial wire crosses the outer edge of the double ring.
      </p>
      <ol class="schematic-legend">
        <li v-for="t in targets" :key="t.key"><strong>{{ t.label }}</strong> - {{ t.hint }}</li>
      </ol>
    </figcaption>
  </figure>
</template>

<style scoped>
.schematic {
  margin: 0;
}

.schematic svg {
  display: block;
  width: 100%;
  max-width: 280px;
  margin: 0 auto 8px;
}

.schematic-board {
  fill: #10151c;
  stroke: var(--border);
}

.schematic-target {
  fill: rgba(248, 113, 113, 0.22);
  stroke: var(--danger);
  stroke-width: 2;
}

.schematic-target-cross {
  stroke: var(--danger);
  stroke-width: 1.5;
}

.schematic-target-index {
  fill: #fff;
  font-size: 9px;
  font-weight: 700;
  text-anchor: middle;
  dominant-baseline: central;
  paint-order: stroke;
  stroke: rgba(0, 0, 0, 0.85);
}

.schematic-legend {
  margin: 0;
  padding-left: 18px;
  font-size: 0.85rem;
  color: var(--muted);
}

.schematic-legend strong {
  color: var(--text);
}
</style>
