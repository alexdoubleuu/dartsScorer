/**
 * Standard steel-tip dartboard model (WDF / BDO tournament specification).
 *
 * All dimensions are radii measured from the centre of the bullseye, in millimetres.
 * Verified against the standard board specification:
 *   - inner bull (double bull, scores 50)   diameter 12.7 mm -> radius   6.35 mm
 *   - outer bull (the "25" ring)            diameter 31.8 mm -> radius  15.90 mm
 *   - treble ring, 8 mm radial width, outer edge radius 107 mm -> inner  99.00 mm
 *   - double ring, 8 mm radial width, outer edge radius 170 mm -> inner 162.00 mm
 *   - playing area diameter 340 mm (radius 170 mm); number ring outer diameter 451 mm
 *
 * Anything beyond radius 170 mm is off the scoring area.
 *
 * ---------------------------------------------------------------------------
 * COORDINATE CONVENTIONS
 * ---------------------------------------------------------------------------
 * Board coordinates ("board space"):
 *   - origin at the bullseye
 *   - normalised so that r = 1.0 at the OUTER edge of the double ring (170 mm)
 *   - +Y points towards the 20 segment (12 o'clock)
 *   - +X points towards the 6/10 wire (3 o'clock)
 *   - so: x = r * sin(theta), y = r * cos(theta)
 *
 * Angle convention: `angleFromTopClockwiseDeg` is measured in degrees, clockwise,
 * from the 12 o'clock direction, as seen by a player facing the board.
 *   0   deg -> centre of 20 (top)
 *   90  deg -> centre of 6  (3 o'clock)
 *   180 deg -> centre of 3  (bottom)
 *   270 deg -> centre of 11 (9 o'clock)
 *
 * Image coordinates:
 *   - pixels of the decoded frame
 *   - origin at the top-left, +x right, +y down
 *
 * These conventions are deliberately explicit: `boardPointToPolar` and
 * `boardPointFromPolar` are the only sanctioned conversions between the two
 * board-space representations.
 */

/**
 * Clockwise segment order, starting with 20 at 12 o'clock.
 * Index i is centred at (i * 18) degrees clockwise from the top.
 */
export const SEGMENT_ORDER_CLOCKWISE: readonly number[] = [
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
];

export const SEGMENT_COUNT = SEGMENT_ORDER_CLOCKWISE.length; // 20
export const SEGMENT_ANGLE_DEG = 360 / SEGMENT_COUNT; // 18
export const SEGMENT_HALF_ANGLE_DEG = SEGMENT_ANGLE_DEG / 2; // 9

/** Radius, in millimetres, that maps to r = 1.0 in normalised board space. */
export const BOARD_UNIT_RADIUS_MM = 170;

export const BOARD_MM = {
  innerBullRadius: 6.35,
  outerBullRadius: 15.9,
  trebleInnerRadius: 99,
  trebleOuterRadius: 107,
  doubleInnerRadius: 162,
  doubleOuterRadius: BOARD_UNIT_RADIUS_MM,
  ringWidth: 8,
  playingAreaRadius: 170,
  numberRingOuterRadius: 225.5,
} as const;

export type RingId =
  | 'inner-bull'
  | 'outer-bull'
  | 'inner-single'
  | 'treble'
  | 'outer-single'
  | 'double'
  | 'off-board';

export interface BoardPoint {
  x: number;
  y: number;
}

export interface BoardPolar {
  /** Normalised radius: 1.0 at the outer edge of the double ring. */
  radius: number;
  /** Degrees clockwise from 12 o'clock, normalised to [0, 360). */
  angleFromTopClockwiseDeg: number;
}

/** Normalise any angle into [0, 360). */
export function normaliseDegrees(deg: number): number {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

export function boardPointFromPolar(radius: number, angleFromTopClockwiseDeg: number): BoardPoint {
  const rad = (angleFromTopClockwiseDeg * Math.PI) / 180;
  return { x: radius * Math.sin(rad), y: radius * Math.cos(rad) };
}

export function boardPointToPolar(p: BoardPoint): BoardPolar {
  return {
    radius: Math.hypot(p.x, p.y),
    angleFromTopClockwiseDeg: normaliseDegrees((Math.atan2(p.x, p.y) * 180) / Math.PI),
  };
}

/**
 * Convert a normalised board radius into millimetres.
 */
export function boardRadiusToMm(radius: number): number {
  return radius * BOARD_UNIT_RADIUS_MM;
}

/**
 * Wedge index in [0, 20) for an angle measured clockwise from the top.
 *
 * The 20 segment is centred on 0 deg and each segment is 18 deg wide, so the
 * wedge boundaries fall at 9 + 18k degrees. The first boundary (9 deg) is
 * assigned to the wedge that starts there (segment 1), i.e. boundaries are
 * lower-bound-inclusive: [start, end). This is the deterministic tie-break used
 * everywhere in this codebase.
 */
export function wedgeIndexAtAngle(angleFromTopClockwiseDeg: number): number {
  const a = normaliseDegrees(angleFromTopClockwiseDeg);
  const raw = Math.floor((a + SEGMENT_HALF_ANGLE_DEG) / SEGMENT_ANGLE_DEG);
  return ((raw % SEGMENT_COUNT) + SEGMENT_COUNT) % SEGMENT_COUNT;
}

/** Centre angle of a wedge index, in degrees clockwise from 12 o'clock. */
export function wedgeCentreAngleDeg(wedgeIndex: number): number {
  const i = ((wedgeIndex % SEGMENT_COUNT) + SEGMENT_COUNT) % SEGMENT_COUNT;
  return i * SEGMENT_ANGLE_DEG;
}

/** The printed number on the wedge at the given angle. */
export function segmentNumberAtAngle(angleFromTopClockwiseDeg: number): number {
  return SEGMENT_ORDER_CLOCKWISE[wedgeIndexAtAngle(angleFromTopClockwiseDeg)];
}

/**
 * Which ring contains a radius expressed in millimetres.
 *
 * Bands are half-open intervals [inner, outer): a radius of exactly 99 mm is
 * treble, exactly 162 mm is double, exactly 170 mm is off-board.
 *
 * WIRE HITS: a real dart can straddle a wire, and the wire itself has physical
 * width, so no purely mathematical rule can resolve a genuine wire hit. This
 * tie-break exists so the software is deterministic and testable, not because
 * it is physically meaningful at the sub-millimetre level.
 */
export function ringFromRadiusMm(radiusMm: number): RingId {
  if (!Number.isFinite(radiusMm) || radiusMm < 0) return 'off-board';
  if (radiusMm < BOARD_MM.innerBullRadius) return 'inner-bull';
  if (radiusMm < BOARD_MM.outerBullRadius) return 'outer-bull';
  if (radiusMm < BOARD_MM.trebleInnerRadius) return 'inner-single';
  if (radiusMm < BOARD_MM.trebleOuterRadius) return 'treble';
  if (radiusMm < BOARD_MM.doubleInnerRadius) return 'outer-single';
  if (radiusMm < BOARD_MM.doubleOuterRadius) return 'double';
  return 'off-board';
}
