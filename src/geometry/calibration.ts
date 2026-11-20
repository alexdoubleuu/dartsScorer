import type { Point, Size } from '../types';
import { applyHomography, mat3Inverse, solveHomography, type Matrix3 } from './homography';
import { boardPointFromPolar } from '../board/boardModel';
import { isInsideImage } from './imageCoords';

/**
 * ---------------------------------------------------------------------------
 * CALIBRATION
 * ---------------------------------------------------------------------------
 * Four correspondences are used to recover the planar projective transform
 * (homography) between the camera image and a top-down, normalised board.
 *
 * Reference points: the OUTER EDGE OF THE DOUBLE RING, exactly where the four
 * radial wires between 20/1, 6/10, 3/19 and 11/14 cross it.
 *
 * Why those four angles? Wedges are 18 deg wide and 20 is centred at 0 deg
 * (12 o'clock), so the 20/1 wire sits 9 deg clockwise of the top. The other
 * three references are the wires 90 deg further round each time:
 *
 *     20/1   at   9 deg clockwise from top   (just right of 12 o'clock)
 *      6/10 at  99 deg clockwise from top   (right side, just below 3 o'clock)
 *      3/19 at 189 deg clockwise from top   (left of 6 o'clock)
 *     11/14 at 279 deg clockwise from top   (left side, just above 9 o'clock)
 *
 * These land at the corners of a square inscribed in the outer double ring,
 * which maximises the baseline between the points and therefore the numerical
 * stability of the transform. All four sit on r = 1.0 of the normalised board.
 */

export type CalibrationRefId = '20|1' | '6|10' | '3|19' | '11|14';

export interface CalibrationRef {
  id: CalibrationRefId;
  /** Wire between these two segments. */
  label: string;
  /** Short instruction shown while the user is tapping. */
  hint: string;
  angleFromTopClockwiseDeg: number;
  /** Expected position in normalised board space (r = 1.0). */
  board: Point;
}

const REF_DEFS: ReadonlyArray<Omit<CalibrationRef, 'board'>> = [
  {
    id: '20|1',
    label: '20 / 1',
    hint: 'Just clockwise of the top of the board.',
    angleFromTopClockwiseDeg: 9,
  },
  {
    id: '6|10',
    label: '6 / 10',
    hint: 'Right-hand side, just below the horizontal.',
    angleFromTopClockwiseDeg: 99,
  },
  {
    id: '3|19',
    label: '3 / 19',
    hint: 'Bottom of the board, slightly to the left.',
    angleFromTopClockwiseDeg: 189,
  },
  {
    id: '11|14',
    label: '11 / 14',
    hint: 'Left-hand side, just above the horizontal.',
    angleFromTopClockwiseDeg: 279,
  },
];

/** Tap order is significant: it fixes which reference each tap corresponds to. */
export const CALIBRATION_REFS: readonly CalibrationRef[] = REF_DEFS.map((def) => ({
  ...def,
  board: boardPointFromPolar(1, def.angleFromTopClockwiseDeg),
}));

export const CALIBRATION_POINT_COUNT = CALIBRATION_REFS.length;

/** Minimum separation between two taps, in image pixels. */
export const MIN_REF_SEPARATION_PX = 6;

/** Minimum quadrilateral area, as a fraction of the image area. */
export const MIN_QUAD_AREA_FRACTION = 0.005;

/** Tolerance when checking the solved transform reproduces the tapped points. */
const MAX_ROUND_TRIP_ERROR = 1e-6;

export interface Calibration {
  imageSize: Size;
  /**
   * Maps NORMALISED image coordinates (x / width, y / height, both in [0, 1])
   * into normalised board space (r = 1.0 at the outer edge of the double ring).
   */
  imageToBoard: Matrix3;
  /** Inverse of `imageToBoard`, for drawing overlays. */
  boardToImage: Matrix3;
  /** The four tapped points, in image pixels, in `CALIBRATION_REFS` order. */
  refPoints: Point[];
  /** Max round-trip error of the fit, in normalised image units. */
  residual: number;
}

export type CalibrationFailureCode =
  | 'wrong-number-of-points'
  | 'non-finite-point'
  | 'out-of-bounds'
  | 'duplicate-points'
  | 'degenerate-quadrilateral'
  | 'unstable-transform';

export interface CalibrationFailure {
  ok: false;
  code: CalibrationFailureCode;
  message: string;
}

export interface CalibrationSuccess {
  ok: true;
  calibration: Calibration;
}

export type CalibrationResult = CalibrationSuccess | CalibrationFailure;

function fail(code: CalibrationFailureCode, message: string): CalibrationFailure {
  return { ok: false, code, message };
}

/** Signed area of a polygon (shoelace). Sign encodes winding direction. */
function signedArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/**
 * A projective transform maps a convex quadrilateral to another convex
 * quadrilateral, so the four tapped points must form a simple (non-self
 * intersecting) convex quad. If they do not, the user almost certainly tapped
 * them in a crossed order or landed two on top of each other.
 */
function isSimpleConvexQuad(points: readonly Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const c = points[(i + 2) % points.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * Build a calibration from four tapped image points.
 *
 * Points must be supplied in `CALIBRATION_REFS` order. Every failure mode
 * returns a structured reason rather than a silently wrong transform.
 */
export function buildCalibration(imagePoints: readonly Point[], imageSize: Size): CalibrationResult {
  if (imagePoints.length !== CALIBRATION_POINT_COUNT) {
    return fail(
      'wrong-number-of-points',
      `Calibration needs exactly ${CALIBRATION_POINT_COUNT} points, got ${imagePoints.length}.`,
    );
  }

  for (const p of imagePoints) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return fail('non-finite-point', 'A calibration point is not a finite coordinate.');
    }
  }

  for (let i = 0; i < imagePoints.length; i += 1) {
    if (!isInsideImage(imagePoints[i], imageSize, 1)) {
      return fail(
        'out-of-bounds',
        `Calibration point ${i + 1} is outside the image (${Math.round(imagePoints[i].x)}, ${Math.round(imagePoints[i].y)}).`,
      );
    }
  }

  for (let i = 0; i < imagePoints.length; i += 1) {
    for (let j = i + 1; j < imagePoints.length; j += 1) {
      const d = Math.hypot(imagePoints[i].x - imagePoints[j].x, imagePoints[i].y - imagePoints[j].y);
      if (d < MIN_REF_SEPARATION_PX) {
        return fail(
          'duplicate-points',
          `Calibration points ${i + 1} and ${j + 1} are only ${d.toFixed(1)} px apart - they must be four distinct wires.`,
        );
      }
    }
  }

  const quadArea = Math.abs(signedArea(imagePoints));
  const imageArea = imageSize.width * imageSize.height;
  if (!Number.isFinite(quadArea) || quadArea < imageArea * MIN_QUAD_AREA_FRACTION) {
    return fail(
      'degenerate-quadrilateral',
      'The four points are nearly collinear or bunched together, which cannot define a perspective transform.',
    );
  }

  if (!isSimpleConvexQuad(imagePoints)) {
    return fail(
      'degenerate-quadrilateral',
      'The four points do not form a simple quadrilateral in the tapped order. Re-tap them in the order 20/1, 6/10, 3/19, 11/14.',
    );
  }

  const sourceNormalised = imagePoints.map((p) => ({
    x: p.x / imageSize.width,
    y: p.y / imageSize.height,
  }));
  const destination = CALIBRATION_REFS.map((r) => r.board);

  const imageToBoard = solveHomography(sourceNormalised, destination);
  if (!imageToBoard) {
    return fail('unstable-transform', 'Could not solve a stable transform from those four points.');
  }

  const boardToImage = mat3Inverse(imageToBoard);
  if (!boardToImage) {
    return fail('unstable-transform', 'The solved transform is singular and cannot be inverted.');
  }

  // The four correspondences make the fit exact, so a large error here means the
  // linear solve went wrong rather than that the data is noisy.
  let residual = 0;
  for (let i = 0; i < sourceNormalised.length; i += 1) {
    const mapped = applyHomography(imageToBoard, sourceNormalised[i]);
    if (!mapped) {
      return fail('unstable-transform', 'A calibration point mapped to infinity through the transform.');
    }
    residual = Math.max(residual, Math.hypot(mapped.x - destination[i].x, mapped.y - destination[i].y));
  }
  if (!Number.isFinite(residual) || residual > MAX_ROUND_TRIP_ERROR) {
    return fail(
      'unstable-transform',
      `The transform does not reproduce the tapped points (residual ${residual.toExponential(2)}).`,
    );
  }

  return {
    ok: true,
    calibration: {
      imageSize: { width: imageSize.width, height: imageSize.height },
      imageToBoard,
      boardToImage,
      refPoints: imagePoints.map((p) => ({ x: p.x, y: p.y })),
      residual,
    },
  };
}

/** Map a point in image pixels into normalised board space. Null if at infinity. */
export function imageToBoardPoint(calibration: Calibration, imagePoint: Point): Point | null {
  return applyHomography(calibration.imageToBoard, {
    x: imagePoint.x / calibration.imageSize.width,
    y: imagePoint.y / calibration.imageSize.height,
  });
}

/** Map a normalised board point back to image pixels. Null if at infinity. */
export function boardToImagePoint(calibration: Calibration, boardPoint: Point): Point | null {
  const p = applyHomography(calibration.boardToImage, boardPoint);
  if (!p) return null;
  return { x: p.x * calibration.imageSize.width, y: p.y * calibration.imageSize.height };
}

/**
 * Radius of the outer double ring in normalised image units, useful as a sanity
 * check on how much of the frame the board occupies.
 */
export function calibratedBoardRadius(calibration: Calibration): number {
  const a = boardToImagePoint(calibration, boardPointFromPolar(0, 0));
  const b = boardToImagePoint(calibration, boardPointFromPolar(1, 0));
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}
