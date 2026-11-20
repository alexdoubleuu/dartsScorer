import type { Point, RectLike, Size } from '../types';

/**
 * Mapping between *image pixel coordinates* (origin top-left of the decoded
 * frame) and *on-screen display coordinates* (CSS pixels in the viewport).
 *
 * The frame is displayed letterboxed inside a box, exactly like
 * `object-fit: contain`. Overlays are drawn with an SVG viewBox in image
 * coordinates so that taps, overlays and stored points all live in one space,
 * even when the box is resized.
 */

export type FitMode = 'contain' | 'cover';

export interface Fit {
  /** display pixels per image pixel */
  scale: number;
  /** rendered size of the image, in display pixels */
  width: number;
  height: number;
  /** letterbox offset of the rendered image inside the box, in display pixels */
  offsetX: number;
  offsetY: number;
}

export function fittedImageRect(image: Size, box: Size, mode: FitMode = 'contain'): Fit {
  if (
    !(image.width > 0) ||
    !(image.height > 0) ||
    !(box.width > 0) ||
    !(box.height > 0)
  ) {
    return { scale: 0, width: 0, height: 0, offsetX: 0, offsetY: 0 };
  }

  const sx = box.width / image.width;
  const sy = box.height / image.height;
  const scale = mode === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
  const width = image.width * scale;
  const height = image.height * scale;

  return {
    scale,
    width,
    height,
    offsetX: (box.width - width) / 2,
    offsetY: (box.height - height) / 2,
  };
}

/** Viewport (client) coordinates -> image pixel coordinates. */
export function displayToImage(
  client: Point,
  box: RectLike,
  image: Size,
  mode: FitMode = 'contain',
): Point {
  const fit = fittedImageRect(image, box, mode);
  if (fit.scale === 0) return { x: 0, y: 0 };
  return {
    x: (client.x - box.left - fit.offsetX) / fit.scale,
    y: (client.y - box.top - fit.offsetY) / fit.scale,
  };
}

/** Image pixel coordinates -> viewport (client) coordinates. */
export function imageToDisplay(
  imagePoint: Point,
  box: RectLike,
  image: Size,
  mode: FitMode = 'contain',
): Point {
  const fit = fittedImageRect(image, box, mode);
  return {
    x: box.left + fit.offsetX + imagePoint.x * fit.scale,
    y: box.top + fit.offsetY + imagePoint.y * fit.scale,
  };
}

/** Distance between two image points, converted to display pixels. */
export function imageDistanceToDisplay(a: Point, b: Point, box: RectLike, image: Size): number {
  const fit = fittedImageRect(image, box);
  return Math.hypot(a.x - b.x, a.y - b.y) * fit.scale;
}

export function clampToImage(p: Point, image: Size): Point {
  return {
    x: Math.min(Math.max(p.x, 0), image.width),
    y: Math.min(Math.max(p.y, 0), image.height),
  };
}

export function isInsideImage(p: Point, image: Size, marginPx = 0): boolean {
  return (
    p.x >= -marginPx &&
    p.y >= -marginPx &&
    p.x <= image.width + marginPx &&
    p.y <= image.height + marginPx
  );
}
