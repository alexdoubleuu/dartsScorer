import { boardToImagePoint, type Calibration } from '../geometry/calibration';
import type { Point, Size } from '../types';

/**
 * ---------------------------------------------------------------------------
 * CALIBRATION-DERIVED BOARD CROP
 * ---------------------------------------------------------------------------
 * The detector sees the whole photo letterboxed into a square, so on a phone
 * photo the board occupies only part of the input and each dart is a handful of
 * pixels wide. Cropping to the board first, using the calibration the app has
 * already solved, raises the resolution the model sees on the board without
 * changing the model, the weights or `imgsz`.
 *
 * The crop rectangle is derived from the calibration alone: project the
 * normalised `r = 1.0` circle (the outer edge of the double ring) through
 * `boardToImage`, take its bounding box, expand it by `pad` and clamp it to the
 * image. No extra model, no detection pass and no hard-coded pixel numbers.
 *
 * Everything here is pure and DOM-free so the transform can be unit tested.
 */

/** Which framing the detector should use. */
export type FrameMode = 'full' | 'board-crop';

/** Fraction of the board bounding box added on every side before cropping. */
export const BOARD_CROP_PAD = 0.15;

/** Sample count used to trace the projected rim. */
const RIM_SAMPLES = 1440;

export interface CropRect {
  /** Left edge in source-image pixels. */
  x: number;
  /** Top edge in source-image pixels. */
  y: number;
  width: number;
  height: number;
}

/**
 * Projected bounding box of the board rim, before padding or clamping.
 * Returns null when no sample maps to a finite image point.
 */
function rimBoundingBox(calibration: Calibration): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = 0;
  for (let k = 0; k < RIM_SAMPLES; k += 1) {
    const t = (k * Math.PI) / (RIM_SAMPLES / 2);
    const projected = boardToImagePoint(calibration, { x: Math.sin(t), y: Math.cos(t) });
    if (!projected) continue;
    seen += 1;
    if (projected.x < minX) minX = projected.x;
    if (projected.y < minY) minY = projected.y;
    if (projected.x > maxX) maxX = projected.x;
    if (projected.y > maxY) maxY = projected.y;
  }
  if (seen === 0) return null;
  return { minX, minY, maxX, maxY };
}

/** Clamp a rectangle to the image, keeping at least one whole pixel. */
export function clampCropRect(rect: CropRect, imageSize: Size): CropRect {
  const left = Math.max(0, Math.min(rect.x, imageSize.width - 1));
  const top = Math.max(0, Math.min(rect.y, imageSize.height - 1));
  const right = Math.max(left + 1, Math.min(rect.x + rect.width, imageSize.width));
  const bottom = Math.max(top + 1, Math.min(rect.y + rect.height, imageSize.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The board crop rectangle in source-image pixels, or null when the board
 * cannot be projected (degenerate calibration).
 */
export function boardCropRect(
  calibration: Calibration,
  imageSize: Size,
  pad: number = BOARD_CROP_PAD,
): CropRect | null {
  const box = rimBoundingBox(calibration);
  if (!box) return null;
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  if (!(width > 0) || !(height > 0)) return null;

  const rect: CropRect = {
    x: Math.floor(box.minX - width * pad),
    y: Math.floor(box.minY - height * pad),
    width: Math.ceil(width * (1 + 2 * pad)),
    height: Math.ceil(height * (1 + 2 * pad)),
  };
  return clampCropRect(rect, imageSize);
}

/** Crop-local pixel coordinates -> source-image pixels. */
export function cropToSourcePoint(point: Point, crop: CropRect | null): Point {
  return crop ? { x: point.x + crop.x, y: point.y + crop.y } : { x: point.x, y: point.y };
}

/** Source-image pixels -> crop-local pixel coordinates. */
export function sourceToCropPoint(point: Point, crop: CropRect | null): Point {
  return crop ? { x: point.x - crop.x, y: point.y - crop.y } : { x: point.x, y: point.y };
}
