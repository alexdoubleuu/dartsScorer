import type { Point, RectLike, Size } from '../types';

/**
 * ---------------------------------------------------------------------------
 * VIEW TRANSFORM
 * ---------------------------------------------------------------------------
 * The single, explicit affine transform between SOURCE-IMAGE pixel coordinates
 * and DISPLAY pixel coordinates, including the zoom/pan of the on-screen
 * workspace.
 *
 * Everything the user sees - the photo, the projected board overlay and every
 * marker - is stored in image pixels and drawn through this one transform, so
 * markers cannot drift from the photo: there is exactly one place where image
 * space becomes screen space.
 *
 *     display = origin + image * scale
 *     origin  = viewportCentre - focus * scale
 *     scale   = containFit * zoom
 *
 * `focus` is the image point held at the centre of the viewport. Keeping the
 * view as an image-space focus (instead of a screen-space offset) means the
 * workspace stays sensible when the viewport is resized or the phone is
 * rotated: the same part of the board stays centred.
 */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

export interface ViewState {
  /** Zoom factor. 1 shows the whole image (contain fit). */
  zoom: number;
  /** Image-pixel point held at the centre of the viewport. */
  focus: Point;
}

export interface Projection {
  /** Display pixels per image pixel. */
  scale: number;
  /** Display x of image x = 0. */
  originX: number;
  /** Display y of image y = 0. */
  originY: number;
}

/** Contain-fit scale (like `object-fit: contain`). 0 for empty or non-finite sizes. */
export function fitScale(image: Size, viewport: Size): number {
  if (
    !(image.width > 0) ||
    !(image.height > 0) ||
    !(viewport.width > 0) ||
    !(viewport.height > 0)
  ) {
    return 0;
  }
  return Math.min(viewport.width / image.width, viewport.height / image.height);
}

/** A view that shows the whole image, centred, with no zoom. */
export function defaultView(image: Size): ViewState {
  return { zoom: MIN_ZOOM, focus: { x: image.width / 2, y: image.height / 2 } };
}

/** Solve the display transform for the current view. */
export function createProjection(view: ViewState, image: Size, viewport: Size): Projection {
  const scale = fitScale(image, viewport) * view.zoom;
  return {
    scale,
    originX: viewport.width / 2 - view.focus.x * scale,
    originY: viewport.height / 2 - view.focus.y * scale,
  };
}

/** Image pixel coordinates -> display pixel coordinates. */
export function displayFromImage(p: Point, proj: Projection): Point {
  return { x: proj.originX + p.x * proj.scale, y: proj.originY + p.y * proj.scale };
}

/** Display pixel coordinates -> image pixel coordinates. Exact inverse of `displayFromImage`. */
export function imageFromDisplay(q: Point, proj: Projection): Point {
  if (!(proj.scale > 0)) return { x: 0, y: 0 };
  return { x: (q.x - proj.originX) / proj.scale, y: (q.y - proj.originY) / proj.scale };
}

/** The rectangle the image occupies in display space. */
export function projectedRect(proj: Projection, image: Size): RectLike {
  return {
    left: proj.originX,
    top: proj.originY,
    width: image.width * proj.scale,
    height: image.height * proj.scale,
  };
}

/** Clamp zoom into the allowed range and keep the focus inside the image bounds. */
export function clampView(view: ViewState, image: Size): ViewState {
  if (
    !Number.isFinite(view.zoom) ||
    !Number.isFinite(view.focus.x) ||
    !Number.isFinite(view.focus.y)
  ) {
    return defaultView(image);
  }
  return {
    zoom: Math.min(Math.max(view.zoom, MIN_ZOOM), MAX_ZOOM),
    focus: {
      x: Math.min(Math.max(view.focus.x, 0), image.width),
      y: Math.min(Math.max(view.focus.y, 0), image.height),
    },
  };
}

/**
 * Zoom to `nextZoom` while keeping the image point currently under
 * `anchorDisplay` pinned to that screen position (so pinch-zoom grows around
 * the fingers rather than around the centre).
 */
export function zoomAt(
  view: ViewState,
  image: Size,
  viewport: Size,
  anchorDisplay: Point,
  nextZoom: number,
): ViewState {
  const anchorImage = imageFromDisplay(anchorDisplay, createProjection(view, image, viewport));
  const scale = fitScale(image, viewport) * nextZoom;
  if (!(scale > 0)) return clampView(view, image);
  return clampView(
    {
      zoom: nextZoom,
      focus: {
        x: (viewport.width / 2 - anchorDisplay.x) / scale + anchorImage.x,
        y: (viewport.height / 2 - anchorDisplay.y) / scale + anchorImage.y,
      },
    },
    image,
  );
}

/**
 * Pan the content by a display-pixel delta. Positive `dx` moves the image to
 * the right, i.e. the content follows the finger.
 */
export function panBy(
  view: ViewState,
  image: Size,
  viewport: Size,
  dxDisplay: number,
  dyDisplay: number,
): ViewState {
  const scale = fitScale(image, viewport) * view.zoom;
  if (!(scale > 0)) return clampView(view, image);
  return clampView(
    {
      zoom: view.zoom,
      focus: { x: view.focus.x - dxDisplay / scale, y: view.focus.y - dyDisplay / scale },
    },
    image,
  );
}
