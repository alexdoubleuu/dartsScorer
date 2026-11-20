import { describe, expect, it } from 'vitest';
import type { Point, Size } from '../types';
import { applyHomography, type Matrix3 } from './homography';
import {
  CALIBRATION_POINT_COUNT,
  CALIBRATION_REFS,
  boardToImagePoint,
  buildCalibration,
  calibratedBoardRadius,
  imageToBoardPoint,
  type Calibration,
} from './calibration';
import { boardPointFromPolar, BOARD_UNIT_RADIUS_MM } from '../board/boardModel';
import { scoreImagePoint } from '../scoring/score';

const IMAGE: Size = { width: 3000, height: 4000 };

/** A plausible camera view of a board: mild perspective, scaled into the frame. */
const TRUTH: Matrix3 = [820, 40, 1500, -30, 870, 1950, 0.012, 0.006, 1];

/** Image pixels of a normalised board point, as the "camera" would see it. */
function imageOfBoardPoint(boardPoint: Point): Point {
  return applyHomography(TRUTH, boardPoint)!;
}

function perfectTaps(): Point[] {
  return CALIBRATION_REFS.map((ref) => imageOfBoardPoint(ref.board));
}

function buildPerfect(): Calibration {
  const result = buildCalibration(perfectTaps(), IMAGE);
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
  return result.calibration;
}

describe('reference point definition', () => {
  it('uses four references at 9, 99, 189 and 279 degrees clockwise from the top', () => {
    expect(CALIBRATION_POINT_COUNT).toBe(4);
    expect(CALIBRATION_REFS.map((r) => r.id)).toEqual(['20|1', '6|10', '3|19', '11|14']);
    expect(CALIBRATION_REFS.map((r) => r.angleFromTopClockwiseDeg)).toEqual([9, 99, 189, 279]);
  });

  it('places every reference on the outer edge of the double ring', () => {
    for (const ref of CALIBRATION_REFS) {
      expect(Math.hypot(ref.board.x, ref.board.y)).toBeCloseTo(1, 12);
    }
  });

  it('puts the references on the wires between the named segments', () => {
    // Tap i is the wire that separates the two segments in `id`.
    const pairs: Array<[number, number]> = [
      [20, 1],
      [6, 10],
      [3, 19],
      [11, 14],
    ];
    CALIBRATION_REFS.forEach((ref, i) => {
      const [before, after] = pairs[i];
      const [idBefore, idAfter] = ref.id.split('|').map(Number);
      expect([idBefore, idAfter]).toEqual([before, after]);
    });
  });

  it('forms a square inscribed in the unit circle', () => {
    for (let i = 0; i < 4; i += 1) {
      const a = CALIBRATION_REFS[i].board;
      const b = CALIBRATION_REFS[(i + 1) % 4].board;
      const side = Math.hypot(a.x - b.x, a.y - b.y);
      expect(side).toBeCloseTo(Math.SQRT2, 9);
    }
  });
});

describe('a good calibration', () => {
  it('succeeds and reports an essentially exact fit', () => {
    const calibration = buildPerfect();
    expect(calibration.residual).toBeLessThan(1e-9);
    expect(calibration.imageSize).toEqual(IMAGE);
    expect(calibration.refPoints).toHaveLength(4);
  });

  it('maps the tapped points back onto their board references', () => {
    const calibration = buildPerfect();
    CALIBRATION_REFS.forEach((ref, i) => {
      const mapped = imageToBoardPoint(calibration, calibration.refPoints[i]);
      expect(mapped).not.toBeNull();
      expect(mapped!.x).toBeCloseTo(ref.board.x, 9);
      expect(mapped!.y).toBeCloseTo(ref.board.y, 9);
    });
  });

  it('maps the board centre onto the bullseye', () => {
    const calibration = buildPerfect();
    const centre = imageOfBoardPoint({ x: 0, y: 0 });
    const mapped = imageToBoardPoint(calibration, centre)!;
    expect(mapped.x).toBeCloseTo(0, 9);
    expect(mapped.y).toBeCloseTo(0, 9);
    expect(scoreImagePoint(calibration, centre)!.label).toBe('BULL');
  });

  it('scores every wedge centre correctly through the calibration', () => {
    const calibration = buildPerfect();
    const expected = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
    expected.forEach((number, index) => {
      const boardCentre = boardPointFromPolar(85 / BOARD_UNIT_RADIUS_MM, index * 18);
      const score = scoreImagePoint(calibration, imageOfBoardPoint(boardCentre));
      expect(score).not.toBeNull();
      expect(score!.label).toBe(`S${number}`);
    });
  });

  it('scores doubles, trebles, bulls and misses through the calibration', () => {
    const calibration = buildPerfect();
    const cases: Array<[Point, string]> = [
      [boardPointFromPolar(166 / BOARD_UNIT_RADIUS_MM, 0), 'D20'],
      [boardPointFromPolar(103 / BOARD_UNIT_RADIUS_MM, 0), 'T20'],
      [boardPointFromPolar(3 / BOARD_UNIT_RADIUS_MM, 0), 'BULL'],
      [boardPointFromPolar(10 / BOARD_UNIT_RADIUS_MM, 0), '25'],
      [boardPointFromPolar(190 / BOARD_UNIT_RADIUS_MM, 40), 'MISS'],
    ];
    for (const [boardPoint, label] of cases) {
      const score = scoreImagePoint(calibration, imageOfBoardPoint(boardPoint));
      expect(score).not.toBeNull();
      expect(score!.label).toBe(label);
    }
  });

  it('round-trips an arbitrary image point through board space and back', () => {
    const calibration = buildPerfect();
    const probe: Point = { x: 1873, y: 2211 };
    const board = imageToBoardPoint(calibration, probe)!;
    const back = boardToImagePoint(calibration, board)!;
    expect(back.x).toBeCloseTo(probe.x, 6);
    expect(back.y).toBeCloseTo(probe.y, 6);
  });

  it('reports a board radius consistent with the synthetic camera scale', () => {
    const calibration = buildPerfect();
    // Centre to the top of the double ring: about 870 px in TRUTH.
    expect(calibratedBoardRadius(calibration)).toBeGreaterThan(700);
    expect(calibratedBoardRadius(calibration)).toBeLessThan(1100);
  });
});

describe('invalid calibration', () => {
  it('rejects the wrong number of points', () => {
    const tooFew = buildCalibration(perfectTaps().slice(0, 3), IMAGE);
    expect(tooFew.ok).toBe(false);
    if (!tooFew.ok) expect(tooFew.code).toBe('wrong-number-of-points');

    const tooMany = buildCalibration([...perfectTaps(), { x: 10, y: 10 }], IMAGE);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.code).toBe('wrong-number-of-points');
  });

  it('rejects non-finite points', () => {
    const taps = perfectTaps();
    taps[2] = { x: Number.NaN, y: 100 };
    const result = buildCalibration(taps, IMAGE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('non-finite-point');
  });

  it('rejects points outside the image', () => {
    const taps = perfectTaps();
    taps[1] = { x: -12, y: 2000 };
    const result = buildCalibration(taps, IMAGE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('out-of-bounds');
  });

  it('rejects duplicate points', () => {
    const taps = perfectTaps();
    taps[2] = { ...taps[0] };
    const result = buildCalibration(taps, IMAGE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('duplicate-points');
  });

  it('rejects points that are almost on top of each other', () => {
    const taps = perfectTaps();
    taps[2] = { x: taps[0].x + 2, y: taps[0].y + 2 };
    const result = buildCalibration(taps, IMAGE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('duplicate-points');
  });

  it('rejects collinear points', () => {
    const line: Point[] = [
      { x: 400, y: 1000 },
      { x: 800, y: 1400 },
      { x: 1200, y: 1800 },
      { x: 1600, y: 2200 },
    ];
    const result = buildCalibration(line, IMAGE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('degenerate-quadrilateral');
  });

  it('rejects a quad that is too small to define a transform', () => {
    const tiny: Point[] = [
      { x: 1000, y: 1000 },
      { x: 1010, y: 1000 },
      { x: 1010, y: 1010 },
      { x: 1000, y: 1010 },
    ];
    const result = buildCalibration(tiny, IMAGE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('degenerate-quadrilateral');
  });

  it('rejects a crossed (bow-tie) tap order', () => {
    const taps = perfectTaps();
    const crossed = [taps[0], taps[2], taps[1], taps[3]];
    const result = buildCalibration(crossed, IMAGE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('degenerate-quadrilateral');
  });

  it('rejects a concave tap order whose area is still large enough', () => {
    const concave: Point[] = [
      { x: 100, y: 100 },
      { x: 900, y: 100 },
      { x: 500, y: 300 },
      { x: 100, y: 900 },
    ];
    const result = buildCalibration(concave, { width: 1000, height: 1000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('degenerate-quadrilateral');
  });
});
