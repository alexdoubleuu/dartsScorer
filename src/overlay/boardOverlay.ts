import {
  BOARD_MM,
  SEGMENT_ANGLE_DEG,
  SEGMENT_COUNT,
  SEGMENT_HALF_ANGLE_DEG,
  SEGMENT_ORDER_CLOCKWISE,
  boardPointFromPolar,
  wedgeCentreAngleDeg,
} from '../board/boardModel';
import { boardToImagePoint, type Calibration } from '../geometry/calibration';
import type { Point } from '../types';

/**
 * ---------------------------------------------------------------------------
 * BOARD OVERLAY GEOMETRY
 * ---------------------------------------------------------------------------
 * Everything here is expressed in board space and pushed through the
 * calibration's `boardToImage` transform, so the overlay lines up with the
 * tapped calibration points by construction rather than by a second, parallel
 * guess at the geometry.
 *
 * Two consequences of using a projective transform:
 *   - a circle on the board is NOT a circle in the image (it is a conic), so
 *     rings are approximated by sampling many points and drawing a polyline;
 *   - a straight line on the board IS a straight line in the image, so a radial
 *     wire needs only its two endpoints.
 *
 * Coordinates: `Point`s in this module are always IMAGE PIXELS, matching
 * `boardToImagePoint` and the calibration reference points.
 */

export interface OverlayShape {
  key: string;
  /** SVG path data in image pixel coordinates. */
  d: string;
  emphasis: 'normal' | 'strong';
}

export interface OverlayLabel {
  key: string;
  number: number;
  point: Point;
}

/** Samples per ring. 72 keeps the conic smooth at phone resolutions. */
const CIRCLE_SEGMENTS = 72;

/** Board radii drawn as rings, outermost first. */
const RINGS: ReadonlyArray<{ key: string; radiusMm: number; emphasis: OverlayShape['emphasis'] }> = [
  { key: 'double-outer', radiusMm: BOARD_MM.doubleOuterRadius, emphasis: 'strong' },
  { key: 'double-inner', radiusMm: BOARD_MM.doubleInnerRadius, emphasis: 'normal' },
  { key: 'treble-outer', radiusMm: BOARD_MM.trebleOuterRadius, emphasis: 'normal' },
  { key: 'treble-inner', radiusMm: BOARD_MM.trebleInnerRadius, emphasis: 'normal' },
  { key: 'outer-bull', radiusMm: BOARD_MM.outerBullRadius, emphasis: 'normal' },
  { key: 'inner-bull', radiusMm: BOARD_MM.innerBullRadius, emphasis: 'normal' },
];

/** Middle of the number ring band (170 mm to 225.5 mm). */
export const NUMBER_RING_MID_MM = (BOARD_MM.playingAreaRadius + BOARD_MM.numberRingOuterRadius) / 2;

/** Convert a radius in millimetres into normalised board space. */
function radiusToUnit(radiusMm: number): number {
  return radiusMm / BOARD_MM.doubleOuterRadius;
}

/**
 * Push a run of board-space points through the calibration.
 * Returns null when any point maps to infinity, in which case nothing is drawn:
 * a partially drawn ring would be a lie about the geometry.
 */
function pathFromBoardPoints(
  calibration: Calibration,
  points: readonly Point[],
  close: boolean,
): string | null {
  if (points.length === 0) return null;
  const parts: string[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const image = boardToImagePoint(calibration, points[i]);
    if (!image) return null;
    parts.push(`${i === 0 ? 'M' : 'L'}${image.x.toFixed(2)} ${image.y.toFixed(2)}`);
  }
  return `${parts.join(' ')}${close ? ' Z' : ''}`;
}

/** The six wire rings (double, treble, bull). */
export function boardRingShapes(calibration: Calibration): OverlayShape[] {
  const shapes: OverlayShape[] = [];
  for (const ring of RINGS) {
    const unit = radiusToUnit(ring.radiusMm);
    const samples: Point[] = [];
    for (let i = 0; i < CIRCLE_SEGMENTS; i += 1) {
      samples.push(boardPointFromPolar(unit, (i * 360) / CIRCLE_SEGMENTS));
    }
    const d = pathFromBoardPoints(calibration, samples, true);
    if (d) shapes.push({ key: ring.key, d, emphasis: ring.emphasis });
  }
  return shapes;
}

/** The 20 radial wires, from the outer bull edge to the outer double ring. */
export function boardWireShapes(calibration: Calibration): OverlayShape[] {
  const shapes: OverlayShape[] = [];
  const inner = radiusToUnit(BOARD_MM.outerBullRadius);
  const outer = radiusToUnit(BOARD_MM.doubleOuterRadius);

  for (let i = 0; i < SEGMENT_COUNT; i += 1) {
    // Wires sit on the wedge boundaries: 9 + 18k degrees clockwise from the top.
    const angle = SEGMENT_HALF_ANGLE_DEG + i * SEGMENT_ANGLE_DEG;
    const d = pathFromBoardPoints(
      calibration,
      [boardPointFromPolar(inner, angle), boardPointFromPolar(outer, angle)],
      false,
    );
    if (d) shapes.push({ key: `wire-${i}`, d, emphasis: 'normal' });
  }
  return shapes;
}

/** Where to draw the printed segment numbers, centred on each wedge. */
export function boardNumberLabels(calibration: Calibration): OverlayLabel[] {
  const unit = radiusToUnit(NUMBER_RING_MID_MM);
  const labels: OverlayLabel[] = [];
  for (let i = 0; i < SEGMENT_COUNT; i += 1) {
    const image = boardToImagePoint(calibration, boardPointFromPolar(unit, wedgeCentreAngleDeg(i)));
    if (image) labels.push({ key: `number-${i}`, number: SEGMENT_ORDER_CLOCKWISE[i], point: image });
  }
  return labels;
}
