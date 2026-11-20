import { describe, expect, it } from 'vitest';
import type { Point } from '../types';
import {
  applyHomography,
  mat3Det,
  mat3Inverse,
  mat3Mul,
  solveHomography,
  type Matrix3,
} from './homography';

const IDENTITY: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const UNIT_SQUARE: Point[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

function expectPointCloseTo(actual: Point | null, expected: Point, digits = 6) {
  expect(actual).not.toBeNull();
  expect(actual!.x).toBeCloseTo(expected.x, digits);
  expect(actual!.y).toBeCloseTo(expected.y, digits);
}

describe('matrix helpers', () => {
  it('multiplies by the identity', () => {
    const m: Matrix3 = [2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(mat3Mul(m, IDENTITY)).toEqual(m);
    expect(mat3Mul(IDENTITY, m)).toEqual(m);
  });

  it('inverts a matrix', () => {
    const m: Matrix3 = [2, 3, 4, 5, 6, 7, 8, 9, 11];
    const inv = mat3Inverse(m);
    expect(inv).not.toBeNull();
    const product = mat3Mul(m, inv!);
    for (let i = 0; i < 9; i += 1) {
      expect(product[i]).toBeCloseTo(IDENTITY[i], 12);
    }
  });

  it('refuses to invert a singular matrix', () => {
    const singular: Matrix3 = [1, 2, 3, 2, 4, 6, 1, 1, 1];
    expect(mat3Det(singular)).toBeCloseTo(0, 12);
    expect(mat3Inverse(singular)).toBeNull();
  });
});

describe('applyHomography', () => {
  it('returns null when a point maps to infinity', () => {
    // w = x - 1, so x = 1 is the line at infinity.
    const m: Matrix3 = [1, 0, 0, 0, 1, 0, 1, 0, -1];
    expect(applyHomography(m, { x: 1, y: 0.5 })).toBeNull();
    expect(applyHomography(m, { x: 0.5, y: 0 })).not.toBeNull();
  });
});

describe('solveHomography', () => {
  it('recovers the identity from identical point sets', () => {
    const h = solveHomography(UNIT_SQUARE, UNIT_SQUARE);
    expect(h).not.toBeNull();
    expectPointCloseTo(applyHomography(h!, { x: 0.3, y: 0.7 }), { x: 0.3, y: 0.7 }, 12);
  });

  it('recovers a pure similarity (scale and translation)', () => {
    const src: Point[] = [
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 120 },
      { x: 10, y: 120 },
    ];
    const dst = src.map((p) => ({ x: p.x * 2 + 40, y: p.y * 2 + 60 }));
    const h = solveHomography(src, dst);
    expect(h).not.toBeNull();
    expectPointCloseTo(applyHomography(h!, { x: 55, y: 45 }), { x: 150, y: 150 });
  });

  it('recovers a known projective transform at correspondences and elsewhere', () => {
    // A mild perspective: 1.2x scale, shear, translation, and a vanishing line
    // far enough away to stay well conditioned.
    const truth: Matrix3 = [1.2, 0.15, 300, -0.1, 1.05, 480, 0.0004, -0.0002, 1];
    const src: Point[] = [
      { x: 120, y: 140 },
      { x: 980, y: 210 },
      { x: 940, y: 1250 },
      { x: 160, y: 1180 },
    ];
    const dst = src.map((p) => applyHomography(truth, p)!);

    const h = solveHomography(src, dst);
    expect(h).not.toBeNull();

    // Check the four correspondences.
    for (let i = 0; i < 4; i += 1) {
      expectPointCloseTo(applyHomography(h!, src[i]), dst[i], 6);
    }

    // And a point that was never used in the solve.
    const probe = { x: 512.5, y: 733.25 };
    expectPointCloseTo(applyHomography(h!, probe), applyHomography(truth, probe)!, 6);
  });

  it('handles the four board reference points as a known correspondence', () => {
    // The reference square used by the calibration UI, in normalised board space:
    // the outer edge of the double ring at 9, 99, 189 and 279 degrees clockwise
    // from the top.
    const boardRefs: Point[] = [9, 99, 189, 279].map((deg) => {
      const a = (deg * Math.PI) / 180;
      return { x: Math.sin(a), y: Math.cos(a) };
    });

    // A plausible camera view of that square inside a 3000x4000 image.
    const truth: Matrix3 = [820, 40, 1500, -30, 870, 1950, 0.012, 0.006, 1];
    const imagePts = boardRefs.map((p) => applyHomography(truth, p)!);

    const h = solveHomography(imagePts, boardRefs);
    expect(h).not.toBeNull();

    // The centre of the board should land back at the origin of board space.
    const centre = applyHomography(truth, { x: 0, y: 0 })!;
    expectPointCloseTo(applyHomography(h!, centre), { x: 0, y: 0 }, 6);
  });

  it('rejects the wrong number of points', () => {
    expect(solveHomography(UNIT_SQUARE.slice(0, 3), UNIT_SQUARE.slice(0, 3))).toBeNull();
    expect(solveHomography(UNIT_SQUARE, UNIT_SQUARE.slice(0, 3))).toBeNull();
  });

  it('rejects non-finite input', () => {
    const bad = [...UNIT_SQUARE];
    bad[2] = { x: Number.NaN, y: 1 };
    expect(solveHomography(bad, UNIT_SQUARE)).toBeNull();
  });

  it('rejects coincident points', () => {
    const allSame: Point[] = Array.from({ length: 4 }, () => ({ x: 5, y: 5 }));
    expect(solveHomography(allSame, UNIT_SQUARE)).toBeNull();
    expect(solveHomography(UNIT_SQUARE, allSame)).toBeNull();
  });

  it('rejects collinear points', () => {
    const collinear: Point[] = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ];
    expect(solveHomography(collinear, UNIT_SQUARE)).toBeNull();
    expect(solveHomography(UNIT_SQUARE, collinear)).toBeNull();
  });
});

describe('round trip through the inverse', () => {
  it('returns the original point', () => {
    const src: Point[] = [
      { x: 12, y: 34 },
      { x: 890, y: 45 },
      { x: 912, y: 1400 },
      { x: 30, y: 1320 },
    ];
    const dst: Point[] = [
      { x: 0.1564, y: 0.9877 },
      { x: 0.9877, y: -0.1564 },
      { x: -0.1564, y: -0.9877 },
      { x: -0.9877, y: 0.1564 },
    ];
    const forward = solveHomography(src, dst);
    expect(forward).not.toBeNull();
    const backward = mat3Inverse(forward!);
    expect(backward).not.toBeNull();

    for (const p of src) {
      expectPointCloseTo(applyHomography(backward!, applyHomography(forward!, p)!), p, 6);
    }
  });
});
