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
