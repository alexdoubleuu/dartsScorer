import { describe, expect, it } from 'vitest';
import type { Size } from '../types';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampView,
  createProjection,
  defaultView,
  displayFromImage,
  fitScale,
  imageFromDisplay,
  panBy,
  projectedRect,
  zoomAt,
} from './viewTransform';

const IMAGE: Size = { width: 1000, height: 500 };
const SQUARE_VIEWPORT: Size = { width: 500, height: 500 };
const WIDE_VIEWPORT: Size = { width: 1200, height: 600 };

describe('fitScale', () => {
  it('fits a wide image into a square viewport', () => {
    expect(fitScale(IMAGE, SQUARE_VIEWPORT)).toBe(0.5);
  });

  it('fits by the limiting dimension', () => {
    // Both axis ratios are 1.2 here, so the image fills the viewport exactly.
    expect(fitScale(IMAGE, WIDE_VIEWPORT)).toBe(1.2);
    // Height is the tighter axis (0.8) and must win over width (1.2).
    expect(fitScale(IMAGE, { width: 1200, height: 400 })).toBeCloseTo(0.8);
  });

  it('returns 0 for empty or negative sizes', () => {
    expect(fitScale(IMAGE, { width: 0, height: 500 })).toBe(0);
    expect(fitScale({ width: 0, height: 0 }, SQUARE_VIEWPORT)).toBe(0);
  });
});

describe('projection', () => {
  it('centres and letterboxes the whole image at zoom 1', () => {
    const proj = createProjection(defaultView(IMAGE), IMAGE, SQUARE_VIEWPORT);
    expect(proj.scale).toBe(0.5);
    // Image is 500x250 inside a 500x500 box -> 125 px bars top and bottom.
    expect(projectedRect(proj, IMAGE)).toEqual({ left: 0, top: 125, width: 500, height: 250 });
  });

  it('maps the image corners onto the projected rectangle', () => {
    const proj = createProjection(defaultView(IMAGE), IMAGE, SQUARE_VIEWPORT);
    expect(displayFromImage({ x: 0, y: 0 }, proj)).toEqual({ x: 0, y: 125 });
    expect(displayFromImage({ x: 1000, y: 500 }, proj)).toEqual({ x: 500, y: 375 });
  });

  it('is an exact inverse pair across zoom levels and viewports', () => {
    for (const viewport of [SQUARE_VIEWPORT, WIDE_VIEWPORT]) {
      for (const zoom of [1, 1.7, 3, 8]) {
        const view = { zoom, focus: { x: 420, y: 260 } };
        const proj = createProjection(view, IMAGE, viewport);
        for (const p of [
          { x: 0, y: 0 },
          { x: 1000, y: 500 },
          { x: 137, y: 421 },
          { x: 999.5, y: 0.5 },
        ]) {
          const back = imageFromDisplay(displayFromImage(p, proj), proj);
          expect(back.x).toBeCloseTo(p.x, 9);
          expect(back.y).toBeCloseTo(p.y, 9);
        }
      }
    }
  });

  it('returns the origin for a degenerate projection instead of NaN', () => {
    const proj = createProjection(defaultView(IMAGE), IMAGE, { width: 0, height: 0 });
    expect(imageFromDisplay({ x: 10, y: 10 }, proj)).toEqual({ x: 0, y: 0 });
  });
});

describe('zoomAt', () => {
  it('keeps the anchored image point fixed under the anchor', () => {
    const anchor = { x: 100, y: 200 };
    const start = defaultView(IMAGE);
    const before = imageFromDisplay(anchor, createProjection(start, IMAGE, SQUARE_VIEWPORT));

    const zoomed = zoomAt(start, IMAGE, SQUARE_VIEWPORT, anchor, 3);
    const after = displayFromImage(before, createProjection(zoomed, IMAGE, SQUARE_VIEWPORT));

    expect(after.x).toBeCloseTo(anchor.x, 6);
    expect(after.y).toBeCloseTo(anchor.y, 6);
  });

  it('clamps the resulting zoom', () => {
    expect(zoomAt(defaultView(IMAGE), IMAGE, SQUARE_VIEWPORT, { x: 0, y: 0 }, 100).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(defaultView(IMAGE), IMAGE, SQUARE_VIEWPORT, { x: 0, y: 0 }, 0.1).zoom).toBe(MIN_ZOOM);
  });
});

describe('panBy', () => {
  it('moves content by the display delta', () => {
    const start = defaultView(IMAGE);
    const point = { x: 500, y: 250 };
    const before = displayFromImage(point, createProjection(start, IMAGE, SQUARE_VIEWPORT));
    const panned = panBy(start, IMAGE, SQUARE_VIEWPORT, 50, -20);
    const after = displayFromImage(point, createProjection(panned, IMAGE, SQUARE_VIEWPORT));

    expect(after.x - before.x).toBeCloseTo(50, 6);
    expect(after.y - before.y).toBeCloseTo(-20, 6);
  });

  it('is reversible', () => {
    const start = defaultView(IMAGE);
    const there = panBy(start, IMAGE, SQUARE_VIEWPORT, 60, 40);
    const back = panBy(there, IMAGE, SQUARE_VIEWPORT, -60, -40);
    expect(back.focus.x).toBeCloseTo(start.focus.x, 6);
    expect(back.focus.y).toBeCloseTo(start.focus.y, 6);
  });
});

describe('clampView', () => {
  it('bounds zoom and keeps the focus inside the image', () => {
    expect(clampView({ zoom: 20, focus: { x: 5000, y: -5 } }, IMAGE)).toEqual({
      zoom: MAX_ZOOM,
      focus: { x: 1000, y: 0 },
    });
    expect(clampView({ zoom: 0.2, focus: { x: -40, y: 900 } }, IMAGE)).toEqual({
      zoom: MIN_ZOOM,
      focus: { x: 0, y: 500 },
    });
  });

  it('falls back to the default view for non-finite input', () => {
    expect(clampView({ zoom: NaN, focus: { x: 1, y: 1 } }, IMAGE)).toEqual(defaultView(IMAGE));
  });
});
