import { describe, expect, it } from 'vitest';
import { CALIBRATION_REFS, buildCalibration, type Calibration } from '../geometry/calibration';
import { letterboxGeometry, mapLetterboxedToSource } from './yolov8';
import {
  BOARD_CROP_PAD,
  boardCropRect,
  clampCropRect,
  cropToSourcePoint,
  sourceToCropPoint,
  type CropRect,
} from './crop';

const IMGSZ = 800;
const IMAGE = { width: 800, height: 800 };

/**
 * Build a synthetic but valid calibration: the normalised board is scaled to
 * `radiusPx` and centred in the frame, which makes every expected crop edge
 * easy to state exactly.
 */
function circularCalibration(radiusPx: number, imageSize = IMAGE): Calibration {
  const centre = { x: imageSize.width / 2, y: imageSize.height / 2 };
  const refs = CALIBRATION_REFS.map((ref) => ({
    x: centre.x + ref.board.x * radiusPx,
    y: centre.y + ref.board.y * radiusPx,
  }));
  const result = buildCalibration(refs, imageSize);
  if (!result.ok) throw new Error(`Test calibration failed: ${result.message}`);
  return result.calibration;
}

/**
 * Compare crop rectangles within `tol` px. The homography solve introduces
 * sub-pixel error, so `floor`/`ceil` edges can land one pixel either way; the
 * property that matters is that the crop encloses the board and sits on the
 * image, which the containment assertions below check.
 */
function expectRectClose(actual: CropRect | null, expected: CropRect, tol = 1): void {
  expect(actual).not.toBeNull();
  const a = actual as CropRect;
  expect(Math.abs(a.x - expected.x)).toBeLessThanOrEqual(tol);
  expect(Math.abs(a.y - expected.y)).toBeLessThanOrEqual(tol);
  expect(Math.abs(a.width - expected.width)).toBeLessThanOrEqual(tol);
  expect(Math.abs(a.height - expected.height)).toBeLessThanOrEqual(tol);
}

describe('boardCropRect', () => {
  it('pads the projected board bounding box by the default ratio', () => {
    // Board rim is a 600 px circle; +2 * 0.15 padding on the 600 px box = 780.
    expectRectClose(boardCropRect(circularCalibration(300), IMAGE), {
      x: 10,
      y: 10,
      width: 780,
      height: 780,
    });
    expect(BOARD_CROP_PAD).toBe(0.15);
  });

  it('honours an explicit pad, including pad 0 (the bare board box)', () => {
    expectRectClose(boardCropRect(circularCalibration(300), IMAGE, 0), {
      x: 100,
      y: 100,
      width: 600,
      height: 600,
    });
  });

  it('clamps to the image when the padded board would overflow', () => {
    // 380 px radius: the board itself fits, but the padded box runs off every edge.
    expect(boardCropRect(circularCalibration(380), IMAGE)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 800,
    });
  });

  it('respects a non-square image when clamping', () => {
    const imageSize = { width: 1000, height: 600 };
    const crop = boardCropRect(circularCalibration(300, imageSize), imageSize);
    expect(crop).not.toBeNull();
    expect(crop!.x).toBeGreaterThanOrEqual(0);
    expect(crop!.y).toBeGreaterThanOrEqual(0);
    expect(crop!.x + crop!.width).toBeLessThanOrEqual(imageSize.width);
    expect(crop!.y + crop!.height).toBeLessThanOrEqual(imageSize.height);
  });
});

describe('clampCropRect', () => {
  it('leaves an in-bounds rectangle untouched', () => {
    const rect: CropRect = { x: 10, y: 20, width: 100, height: 50 };
    expect(clampCropRect(rect, IMAGE)).toEqual(rect);
  });

  it('pushes a negative origin to zero and keeps it on the image', () => {
    expect(clampCropRect({ x: -40, y: -10, width: 200, height: 200 }, IMAGE)).toEqual({
      x: 0,
      y: 0,
      width: 160,
      height: 190,
    });
  });

  it('never returns a zero-area rectangle at the far edge', () => {
    const clamped = clampCropRect({ x: 799, y: 799, width: 0, height: 0 }, IMAGE);
    expect(clamped.width).toBeGreaterThanOrEqual(1);
    expect(clamped.height).toBeGreaterThanOrEqual(1);
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(IMAGE.width);
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(IMAGE.height);
  });
});

describe('crop coordinate round trips', () => {
  const crop: CropRect = { x: 37, y: 129, width: 640, height: 512 };

  it('sourceToCropPoint and cropToSourcePoint are exact inverses', () => {
    const source = { x: 300.25, y: 410.75 };
    const local = sourceToCropPoint(source, crop);
    expect(local).toEqual({ x: source.x - crop.x, y: source.y - crop.y });
    expect(cropToSourcePoint(local, crop)).toEqual(source);
  });

  it('is a no-op when no crop is applied', () => {
    const point = { x: 12, y: 34 };
    expect(sourceToCropPoint(point, null)).toEqual(point);
    expect(cropToSourcePoint(point, null)).toEqual(point);
  });

  it('round trips through the letterbox exactly as the detector reverses it', () => {
    // Mirrors yolov8Detector: crop-local -> letterbox -> mapLetterboxedToSource
    // -> add crop origin. Any drift here is what the inverse transform would
    // ship as a scoring error.
    const region = { width: crop.width, height: crop.height };
    const geometry = letterboxGeometry(region, IMGSZ);
    const originals = [
      { x: 40, y: 40 },
      { x: 300, y: 256 },
      { x: 639, y: 511 },
    ];
    for (const source of originals) {
      const local = sourceToCropPoint(source, crop);
      const letterboxed = {
        x: local.x * geometry.ratio + geometry.left,
        y: local.y * geometry.ratio + geometry.top,
      };
      const back = cropToSourcePoint(mapLetterboxedToSource(letterboxed, geometry), crop);
      expect(back.x).toBeCloseTo(source.x, 6);
      expect(back.y).toBeCloseTo(source.y, 6);
    }
  });
});
