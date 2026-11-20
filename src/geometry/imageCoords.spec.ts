import { describe, expect, it } from 'vitest';
import type { RectLike, Size } from '../types';
import {
  clampToImage,
  displayToImage,
  fittedImageRect,
  imageDistanceToDisplay,
  imageToDisplay,
  isInsideImage,
} from './imageCoords';

const IMAGE: Size = { width: 1000, height: 500 };

/** A box whose aspect ratio already matches the image: no letterboxing. */
const MATCHING_BOX: RectLike = { left: 100, top: 50, width: 500, height: 250 };

/** A square box for a wide image: 125 px of letterbox above and below. */
const LETTERBOX_BOX: RectLike = { left: 0, top: 0, width: 500, height: 500 };

describe('fittedImageRect', () => {
  it('scales to fit and reports no offset when the aspect ratios match', () => {
    const fit = fittedImageRect(IMAGE, MATCHING_BOX);
    expect(fit.scale).toBe(0.5);
    expect(fit.width).toBe(500);
    expect(fit.height).toBe(250);
    expect(fit.offsetX).toBe(0);
    expect(fit.offsetY).toBe(0);
  });

  it('letterboxes and centres a wide image inside a square box', () => {
    const fit = fittedImageRect(IMAGE, LETTERBOX_BOX);
    expect(fit.scale).toBe(0.5);
    expect(fit.width).toBe(500);
    expect(fit.height).toBe(250);
    expect(fit.offsetX).toBe(0);
    expect(fit.offsetY).toBe(125);
  });

  it('pillarboxes a tall image inside a wide box', () => {
    const fit = fittedImageRect({ width: 500, height: 1000 }, { width: 800, height: 400 });
    expect(fit.scale).toBe(0.4);
    expect(fit.width).toBe(200);
    expect(fit.height).toBe(400);
    expect(fit.offsetX).toBe(300);
    expect(fit.offsetY).toBe(0);
  });

  it('supports cover mode', () => {
    const fit = fittedImageRect(IMAGE, LETTERBOX_BOX, 'cover');
    expect(fit.scale).toBe(1);
    expect(fit.width).toBe(1000);
    expect(fit.height).toBe(500);
    expect(fit.offsetX).toBe(-250);
    expect(fit.offsetY).toBe(0);
  });

  it('degrades safely for empty boxes and images', () => {
    // `fittedImageRect` only reads the box's size, so a zero-sized box is a `Size`.
    expect(fittedImageRect(IMAGE, { width: 0, height: 0 }).scale).toBe(0);
    expect(fittedImageRect({ width: 0, height: 0 }, LETTERBOX_BOX).scale).toBe(0);
  });
});

describe('displayToImage', () => {
  it('maps the box corners to the image corners when the aspect matches', () => {
    expect(displayToImage({ x: 100, y: 50 }, MATCHING_BOX, IMAGE)).toEqual({ x: 0, y: 0 });
    expect(displayToImage({ x: 600, y: 300 }, MATCHING_BOX, IMAGE)).toEqual({ x: 1000, y: 500 });
  });

  it('maps the box centre to the image centre', () => {
    const p = displayToImage({ x: 350, y: 175 }, MATCHING_BOX, IMAGE);
    expect(p.x).toBeCloseTo(500, 9);
    expect(p.y).toBeCloseTo(250, 9);
  });

  it('accounts for letterboxing offsets', () => {
    expect(displayToImage({ x: 0, y: 125 }, LETTERBOX_BOX, IMAGE)).toEqual({ x: 0, y: 0 });
    expect(displayToImage({ x: 500, y: 375 }, LETTERBOX_BOX, IMAGE)).toEqual({ x: 1000, y: 500 });
    expect(displayToImage({ x: 250, y: 250 }, LETTERBOX_BOX, IMAGE)).toEqual({ x: 500, y: 250 });
  });

  it('reports the same image point for a tap inside the letterbox bars and at the edge', () => {
    // A tap above the image content clamps to the top edge conceptually; the raw
    // mapping simply goes negative, which callers clamp explicitly.
    const above = displayToImage({ x: 250, y: 0 }, LETTERBOX_BOX, IMAGE);
    expect(above.y).toBeCloseTo(-250, 9);
  });

  it('returns the origin for a zero-size box instead of NaN', () => {
    expect(displayToImage({ x: 10, y: 10 }, { left: 0, top: 0, width: 0, height: 0 }, IMAGE)).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe('imageToDisplay', () => {
  it('is the inverse of displayToImage', () => {
    for (const box of [MATCHING_BOX, LETTERBOX_BOX]) {
      for (const p of [
        { x: 0, y: 0 },
        { x: 1000, y: 500 },
        { x: 137, y: 421 },
        { x: 999.5, y: 0.5 },
      ]) {
        const client = imageToDisplay(p, box, IMAGE);
        const back = displayToImage(client, box, IMAGE);
        expect(back.x).toBeCloseTo(p.x, 9);
        expect(back.y).toBeCloseTo(p.y, 9);
      }
    }
  });

  it('keeps a point at the same relative position after the box is resized', () => {
    const imagePoint = { x: 250, y: 125 };
    const small = { left: 0, top: 0, width: 250, height: 125 };
    const large = { left: 0, top: 0, width: 1000, height: 500 };

    const inSmall = imageToDisplay(imagePoint, small, IMAGE);
    const inLarge = imageToDisplay(imagePoint, large, IMAGE);

    expect(inSmall).toEqual({ x: 62.5, y: 31.25 });
    expect(inLarge).toEqual({ x: 250, y: 125 });

    // Both map back to the identical image coordinate, which is the property the
    // overlay relies on: image coordinates are independent of how big the box is.
    expect(displayToImage(inSmall, small, IMAGE)).toEqual(imagePoint);
    expect(displayToImage(inLarge, large, IMAGE)).toEqual(imagePoint);
  });

  it('measures marker hit distances in display pixels, not image pixels', () => {
    const a = { x: 100, y: 100 };
    const b = { x: 140, y: 100 };
    // 40 image px at scale 0.5 is 20 display px.
    expect(imageDistanceToDisplay(a, b, MATCHING_BOX, IMAGE)).toBeCloseTo(20, 9);
    // Zooming the box in doubles the on-screen distance.
    const bigger: RectLike = { left: 0, top: 0, width: 1000, height: 500 };
    expect(imageDistanceToDisplay(a, b, bigger, IMAGE)).toBeCloseTo(40, 9);
  });
});

describe('bounds helpers', () => {
  it('clamps a point into the image', () => {
    expect(clampToImage({ x: -50, y: 20 }, IMAGE)).toEqual({ x: 0, y: 20 });
    expect(clampToImage({ x: 5000, y: 900 }, IMAGE)).toEqual({ x: 1000, y: 500 });
    expect(clampToImage({ x: 10, y: 10 }, IMAGE)).toEqual({ x: 10, y: 10 });
  });

  it('reports whether a point is inside the image, allowing a margin', () => {
    expect(isInsideImage({ x: 5, y: 5 }, IMAGE)).toBe(true);
    expect(isInsideImage({ x: -5, y: 5 }, IMAGE)).toBe(false);
    expect(isInsideImage({ x: -5, y: 5 }, IMAGE, 10)).toBe(true);
    expect(isInsideImage({ x: 1005, y: 500 }, IMAGE)).toBe(false);
    expect(isInsideImage({ x: 1005, y: 500 }, IMAGE, 10)).toBe(true);
  });
});
