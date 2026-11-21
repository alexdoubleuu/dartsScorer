import type { Point, Size } from '../types';

/**
 * ---------------------------------------------------------------------------
 * YOLOv8 DETECTION MATHS - PURE, NO RUNTIME
 * ---------------------------------------------------------------------------
 * Everything here is framework-free and DOM-free so it can be unit tested
 * against the reference Python implementation. The runtime lives in
 * `yolov8Detector.ts`; this file only knows how to turn pixels into a tensor
 * description and how to turn a raw output blob into image points.
 *
 * The model is a YOLOv8 detection model exported by Ultralytics, so the
 * conventions below are Ultralytics' own:
 *
 *   - input  : float32, shape [1, 3, imgsz, imgsz], RGB, scaled to 0..1
 *   - letterbox: uniform scale to fit imgsz, centred, padded with grey 114
 *   - output : float32, shape [1, 4 + classCount, anchors]
 *              rows 0..3 are box cx, cy, w, h in LETTERBOXED pixels
 *              rows 4.. are per-class scores for the same anchor
 */

/** Grey fill Ultralytics pads letterboxed images with. */
export const LETTERBOX_PAD = 114;

export interface LetterboxGeometry {
  /** Uniform scale applied to the source image. */
  ratio: number;
  /** Left offset of the scaled image inside the square canvas, in pixels. */
  left: number;
  /** Top offset of the scaled image inside the square canvas, in pixels. */
  top: number;
  /** Scaled image size before padding. */
  newWidth: number;
  newHeight: number;
}

/**
 * Ultralytics letterbox geometry: scale by the smaller of the two axis ratios
 * so the whole image fits, then centre it in a square of side `imgsz`.
 *
 * Rounding is deliberate and mirrors `letterbox()` in the reference Python
 * script (`round` for the scaled size, floor for the offset).
 */
export function letterboxGeometry(source: Size, imgsz: number): LetterboxGeometry {
  const ratio = Math.min(imgsz / source.height, imgsz / source.width);
  const newWidth = Math.round(source.width * ratio);
  const newHeight = Math.round(source.height * ratio);
  const left = Math.floor((imgsz - newWidth) / 2);
  const top = Math.floor((imgsz - newHeight) / 2);
  return { ratio, left, top, newWidth, newHeight };
}

/** A single decoded candidate, still in letterboxed-pixel coordinates. */
export interface RawDetection {
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** Best class score for this anchor, 0..1. */
  confidence: number;
  /** Index of the best class. */
  classId: number;
}

export interface DecodeOptions {
  /** Total output rows: 4 box values plus one per class. */
  channels: number;
  /** Number of candidate anchors. */
  anchors: number;
  /** Number of classes (channels - 4). */
  classCount: number;
  /** Drop candidates below this score. */
  confidenceThreshold: number;
  /** Intersection-over-union above which a weaker box is suppressed. */
  iouThreshold: number;
}

/**
 * Decode a YOLOv8 detection tensor laid out [1, channels, anchors].
 *
 * `output` is the flat Float32Array from the runtime, row-major, so the value
 * of row `c` at anchor `n` is at `c * anchors + n`.
 */
export function decodeYolov8(output: Float32Array, options: DecodeOptions): RawDetection[] {
  const { channels, anchors, classCount, confidenceThreshold, iouThreshold } = options;

  if (channels !== classCount + 4) {
    throw new Error(`Output has ${channels} rows but ${classCount} classes need ${classCount + 4}.`);
  }
  if (output.length < channels * anchors) {
    throw new Error(`Output has ${output.length} values, expected ${channels * anchors}.`);
  }

  const candidates: RawDetection[] = [];

  for (let n = 0; n < anchors; n += 1) {
    let best = -Infinity;
    let bestId = -1;
    for (let c = 0; c < classCount; c += 1) {
      const score = output[(4 + c) * anchors + n];
      if (score > best) {
        best = score;
        bestId = c;
      }
    }
    if (best < confidenceThreshold) continue;
    candidates.push({
      cx: output[n],
      cy: output[anchors + n],
      width: output[2 * anchors + n],
      height: output[3 * anchors + n],
      confidence: best,
      classId: bestId,
    });
  }

  return nonMaxSuppression(candidates, iouThreshold);
}

/** Intersection over union of two boxes expressed as centre + size. */
function intersectionOverUnion(a: RawDetection, b: RawDetection): number {
  const ax1 = a.cx - a.width / 2;
  const ay1 = a.cy - a.height / 2;
  const ax2 = a.cx + a.width / 2;
  const ay2 = a.cy + a.height / 2;
  const bx1 = b.cx - b.width / 2;
  const by1 = b.cy - b.height / 2;
  const bx2 = b.cx + b.width / 2;
  const by2 = b.cy + b.height / 2;

  const iw = Math.min(ax2, bx2) - Math.max(ax1, bx1);
  const ih = Math.min(ay2, by2) - Math.max(ay1, by1);
  if (iw <= 0 || ih <= 0) return 0;

  const intersection = iw * ih;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/**
 * Greedy non-maximum suppression over same-class candidates.
 *
 * The training labels mark each dart with a tiny fixed-size box, so boxes
 * overlap only when the model is genuinely undecided about one dart; a low
 * overlap threshold is therefore enough and the result is order-stable
 * because stronger boxes are always visited first.
 */
export function nonMaxSuppression(
  candidates: RawDetection[],
  iouThreshold: number,
): RawDetection[] {
  const ordered = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const kept: RawDetection[] = [];

  for (const candidate of ordered) {
    const overlaps = kept.some(
      (k) => k.classId === candidate.classId && intersectionOverUnion(k, candidate) > iouThreshold,
    );
    if (!overlaps) kept.push(candidate);
  }

  return kept;
}

/**
 * Map a letterboxed-pixel box centre back to the source image.
 *
 * This is the inverse of `letterboxGeometry` and the transform that must be
 * right: every unit of error here becomes a scoring error, because the score
 * is derived from where the point lands on the board.
 */
export function mapLetterboxedToSource(
  point: Point,
  geometry: LetterboxGeometry,
): Point {
  return {
    x: (point.x - geometry.left) / geometry.ratio,
    y: (point.y - geometry.top) / geometry.ratio,
  };
}
