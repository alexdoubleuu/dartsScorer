/** Shared, framework-free geometry primitives. */

/** A point in some 2D coordinate system. The caller decides which one. */
export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** A DOMRect-like subset, so this module stays testable without a DOM. */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A point drawn on top of the frozen image and editable by dragging.
 *
 * `kind` exists so the UI can never confuse a calibration tap with a dart: a
 * calibration marker is a reference wire the user tapped, a dart marker is a
 * manually entered dart entry point.
 */
export interface TapperMarker {
  id: string;
  /** Image pixel coordinates. */
  point: Point;
  label: string;
  kind: 'calibration' | 'dart';
  selected?: boolean;
}
