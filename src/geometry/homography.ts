import type { Point } from '../types';

/**
 * Row-major 3x3 matrix, used for planar projective transforms (homographies).
 *   [ m0 m1 m2 ]
 *   [ m3 m4 m5 ]
 *   [ m6 m7 m8 ]
 */
export type Matrix3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export function mat3Mul(a: Matrix3, b: Matrix3): Matrix3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += a[r * 3 + k] * b[k * 3 + c];
      out[r * 3 + c] = sum;
    }
  }
  return out as unknown as Matrix3;
}

export function mat3Det(m: Matrix3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

/** Inverse by adjugate. Returns null when the matrix is singular. */
export function mat3Inverse(m: Matrix3): Matrix3 | null {
  const det = mat3Det(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const inv = [
    (m[4] * m[8] - m[5] * m[7]) / det,
    (m[2] * m[7] - m[1] * m[8]) / det,
    (m[1] * m[5] - m[2] * m[4]) / det,
    (m[5] * m[6] - m[3] * m[8]) / det,
    (m[0] * m[8] - m[2] * m[6]) / det,
    (m[2] * m[3] - m[0] * m[5]) / det,
    (m[3] * m[7] - m[4] * m[6]) / det,
    (m[1] * m[6] - m[0] * m[7]) / det,
    (m[0] * m[4] - m[1] * m[3]) / det,
  ];
  for (const v of inv) if (!Number.isFinite(v)) return null;
  return inv as unknown as Matrix3;
}

/**
 * Apply a homography. Returns null when the point maps to (or past) the line at
 * infinity, which is a legitimate outcome for a projective transform.
 */
export function applyHomography(m: Matrix3, p: Point): Point | null {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return null;
  const x = (m[0] * p.x + m[1] * p.y + m[2]) / w;
  const y = (m[3] * p.x + m[4] * p.y + m[5]) / w;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * Solve A x = b with Gaussian elimination and partial pivoting.
 * Returns null when the system is singular (within `eps`).
 */
function solveLinearSystem(A: number[][], b: number[], eps = 1e-12): number[] | null {
  const n = b.length;
  if (A.length !== n) return null;
  const rows = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r;
    }
    if (Math.abs(rows[pivot][col]) < eps) return null;
    if (pivot !== col) {
      const tmp = rows[pivot];
      rows[pivot] = rows[col];
      rows[col] = tmp;
    }
    const pivotValue = rows[col][col];
    for (let r = col + 1; r < n; r += 1) {
      const factor = rows[r][col] / pivotValue;
      if (factor === 0) continue;
      for (let c = col; c <= n; c += 1) rows[r][c] -= factor * rows[col][c];
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    let sum = rows[r][n];
    for (let c = r + 1; c < n; c += 1) sum -= rows[r][c] * x[c];
    x[r] = sum / rows[r][r];
    if (!Number.isFinite(x[r])) return null;
  }
  return x;
}

/**
 * Hartley normalisation: translate the centroid to the origin and scale so the
 * mean distance from the centroid is sqrt(2). Massively improves conditioning of
 * the DLT solve for pixel coordinates in the thousands.
 */
function normalisePoints(points: readonly Point[]): { T: Matrix3; points: Point[] } | null {
  if (points.length === 0) return null;
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;

  let meanDist = 0;
  for (const p of points) meanDist += Math.hypot(p.x - cx, p.y - cy);
  meanDist /= points.length;
  if (!(meanDist > 0) || !Number.isFinite(meanDist)) return null;

  const s = Math.SQRT2 / meanDist;
  const T: Matrix3 = [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
  return { T, points: points.map((p) => ({ x: s * (p.x - cx), y: s * (p.y - cy) })) };
}

const SINGULAR_EPS = 1e-9;

/**
 * Compute the homography mapping exactly four `src` points onto four `dst` points.
 *
 * Four correspondences define a planar projective transform uniquely, so the fit
 * is exact up to floating point. Returns null when the configuration is
 * degenerate: duplicate points, three-or-more collinear points, or a singular
 * linear system.
 */
export function solveHomography(src: readonly Point[], dst: readonly Point[]): Matrix3 | null {
  if (src.length !== 4 || dst.length !== 4) return null;
  if (![...src, ...dst].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;

  const ns = normalisePoints(src);
  const nd = normalisePoints(dst);
  if (!ns || !nd) return null;

  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const u = ns.points[i].x;
    const v = ns.points[i].y;
    const x = nd.points[i].x;
    const y = nd.points[i].y;
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }

  const h = solveLinearSystem(A, b, SINGULAR_EPS);
  if (!h) return null;

  const Hn: Matrix3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const tDstInverse = mat3Inverse(nd.T);
  if (!tDstInverse) return null;

  const result = mat3Mul(tDstInverse, mat3Mul(Hn, ns.T));
  if (!result.every((v) => Number.isFinite(v))) return null;
  if (Math.abs(mat3Det(result)) < 1e-14) return null;

  // With four exact correspondences the fit must reproduce the inputs. If it does
  // not, the configuration was degenerate (collinear or coincident points) and a
  // "solution" was found only by numerical accident.
  for (let i = 0; i < 4; i += 1) {
    const mapped = applyHomography(result, src[i]);
    if (!mapped) return null;
    const scale = Math.max(1, Math.abs(dst[i].x), Math.abs(dst[i].y));
    if (Math.hypot(mapped.x - dst[i].x, mapped.y - dst[i].y) > 1e-6 * scale) return null;
  }

  return result;
}
