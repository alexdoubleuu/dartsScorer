import {
  boardRadiusToMm,
  boardPointToPolar,
  ringFromRadiusMm,
  segmentNumberAtAngle,
  type BoardPoint,
  type RingId,
} from '../board/boardModel';
import { imageToBoardPoint, type Calibration } from '../geometry/calibration';
import type { Point } from '../types';

/**
 * ---------------------------------------------------------------------------
 * SCORING
 * ---------------------------------------------------------------------------
 * Pure functions. No Vue, no DOM, no camera. Everything works in continuous
 * floating point; nothing is rounded before a decision is made.
 *
 * Boundary behaviour is deterministic and documented in `boardModel.ts`:
 * ring bands are half-open [inner, outer), wedge boundaries belong to the wedge
 * that starts at that angle. This makes the code testable - it does NOT make a
 * real wire hit resolvable, because a dart that clips a wire physically belongs
 * to both segments at once.
 */

export type SegmentId = number | 'BULL' | 'MISS';

export interface DartScore {
  /** 1-20 for a numbered wedge, 'BULL' for the bullseye, 'MISS' off the board. */
  segment: SegmentId;
  multiplier: 1 | 2 | 3;
  /** Final points value: 0 for a miss. */
  score: number;
  /** Short display label, e.g. 'T20', 'D16', '25', 'BULL', 'MISS'. */
  label: string;
  /** Which band the point landed in. Additional to the required fields. */
  ring: RingId;
}

export interface MarkedDart {
  id: string;
  point: Point;
  /**
   * A score the user set directly, which wins over the geometric score.
   *
   * Deliberately a separate field from `point`: correcting a mis-scored dart is
   * a scoring change, not a request to move the marked coordinate, so the two
   * must never be conflated. `undefined` means "no override, use geometry";
   * `null` is not used here to keep the "is there an override" test obvious.
   */
  override?: DartScore;
}

export interface ScoredDart extends MarkedDart {
  score: DartScore;
}

/**
 * A marked dart at display time. `score` is null only when the point maps to
 * infinity through the calibration, which cannot be scored. Such a dart is kept
 * and shown as unscorable rather than being silently dropped.
 */
export interface DartEntry extends MarkedDart {
  score: DartScore | null;
  /** True when `score` came from a manual override rather than the geometry. */
  corrected: boolean;
}

const MISS: DartScore = { segment: 'MISS', multiplier: 1, score: 0, label: 'MISS', ring: 'off-board' };

/** Score a point already expressed in normalised board space. */
export function scoreBoardPoint(point: BoardPoint): DartScore {
  const polar = boardPointToPolar(point);
  if (!Number.isFinite(polar.radius) || !Number.isFinite(polar.angleFromTopClockwiseDeg)) {
    return { ...MISS };
  }

  const ring = ringFromRadiusMm(boardRadiusToMm(polar.radius));

  switch (ring) {
    case 'inner-bull':
      return { segment: 'BULL', multiplier: 1, score: 50, label: 'BULL', ring };
    case 'outer-bull':
      return { segment: 'BULL', multiplier: 1, score: 25, label: '25', ring };
    case 'off-board':
      return { ...MISS };
    default: {
      const segment = segmentNumberAtAngle(polar.angleFromTopClockwiseDeg);
      const multiplier: 1 | 2 | 3 = ring === 'double' ? 2 : ring === 'treble' ? 3 : 1;
      const prefix = multiplier === 3 ? 'T' : multiplier === 2 ? 'D' : 'S';
      return {
        segment,
        multiplier,
        score: segment * multiplier,
        label: `${prefix}${segment}`,
        ring,
      };
    }
  }
}

/**
 * Score a tap in image pixel coordinates using an existing calibration.
 * Returns null only when the point maps to infinity, which cannot be scored.
 */
export function scoreImagePoint(calibration: Calibration, imagePoint: Point): DartScore | null {
  const boardPoint = imageToBoardPoint(calibration, imagePoint);
  if (!boardPoint) return null;
  return scoreBoardPoint(boardPoint);
}

export function sumScores(scores: readonly DartScore[]): number {
  return scores.reduce((total, s) => total + s.score, 0);
}

/** The multipliers a manual correction can choose. */
export const MULTIPLIERS = [1, 2, 3] as const;

export type Multiplier = (typeof MULTIPLIERS)[number];

/** Segment choices offered by the correction picker: 1-20, bull and a miss. */
export const CORRECTABLE_SEGMENTS: readonly SegmentId[] = [
  ...Array.from({ length: 20 }, (_, i) => i + 1),
  'BULL',
  'MISS',
];

/**
 * Whether a multiplier is meaningful for a segment. Trebles only exist for
 * numbered wedges; a miss has no multiplier at all.
 */
export function isValidSelection(segment: SegmentId, multiplier: Multiplier): boolean {
  if (segment === 'MISS') return multiplier === 1;
  if (segment === 'BULL') return multiplier === 1 || multiplier === 2;
  return true;
}

/**
 * Build the score a manual correction selected.
 *
 * A "single" has no way to say inner vs outer band from a segment-and-multiplier
 * choice, so the inner single band is used: the points value is identical, and
 * the picker never claims more precision than the user gave it.
 */
export function scoreFromSelection(segment: SegmentId, multiplier: Multiplier): DartScore {
  if (segment === 'MISS') return { ...MISS };
  if (segment === 'BULL') {
    return multiplier === 2
      ? { segment: 'BULL', multiplier: 1, score: 50, label: 'BULL', ring: 'inner-bull' }
      : { segment: 'BULL', multiplier: 1, score: 25, label: '25', ring: 'outer-bull' };
  }
  const ring: RingId = multiplier === 3 ? 'treble' : multiplier === 2 ? 'double' : 'inner-single';
  const prefix = multiplier === 3 ? 'T' : multiplier === 2 ? 'D' : 'S';
  return { segment, multiplier, score: segment * multiplier, label: `${prefix}${segment}`, ring };
}

/** The multiplier a score was recorded with, mapped back for the picker. */
export function multiplierOf(score: DartScore | null): Multiplier {
  if (!score) return 1;
  if (score.segment === 'BULL') return score.score >= 50 ? 2 : 1;
  return score.multiplier;
}

