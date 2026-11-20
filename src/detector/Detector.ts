import type { Point, Size } from '../types';

/**
 * ---------------------------------------------------------------------------
 * FUTURE AUTOMATIC DETECTOR - INTERFACE ONLY, NOT IMPLEMENTED
 * ---------------------------------------------------------------------------
 * Nothing in the current milestone implements this. There is no model file, no
 * weights, no inference runtime and no download URL anywhere in this project,
 * and none may be invented. The manual marking UI is explicitly labelled as
 * manual and must never be presented as AI output.
 *
 * When a real model is chosen, ONNX Runtime Web is the intended runtime, and
 * the model must be bundled or fetched from a source the user controls. Until
 * then this file only pins down the *shape* of the boundary so the manual
 * pipeline can be wired up without a later rewrite.
 *
 * DESIGN NOTE - why entry points, not bounding boxes:
 * Scoring needs the exact point at which the dart tip meets the board face.
 * A bounding box describes where a dart is in the image, which is almost
 * useless for scoring: the box centroid of a dart lying across the 20 wire is
 * nowhere near its entry point. A detector must therefore report a single
 * board-entry coordinate per dart, plus an optional confidence.
 */

export interface DartDetection {
  /**
   * Where the dart tip enters the board face, in image pixel coordinates.
   * Must be in the same coordinate system as the calibration reference points.
   */
  point: Point;

  /**
   * Optional 0..1 confidence. `null` when the detector cannot produce a
   * meaningful number - do not fabricate a value.
   */
  confidence: number | null;

  /**
   * Optional hint for the dart shaft direction: a second image point further
   * along the shaft towards the tail. Useful for drawing an overlay and for
   * disambiguating overlapping darts. `null` when unknown.
   */
  tailHint: Point | null;
}

export interface DetectInput {
  /** The frozen frame to analyse, in the same coordinate system as calibration. */
  imageData: ImageData;
  imageSize: Size;
}

export interface DetectorContext {
  /** Calibration for the frame being analysed, when one exists. */
  imageSize: Size;
}

export interface DartDetector {
  /** Stable identifier, e.g. the model file name plus version. */
  readonly id: string;
  readonly name: string;
  /**
   * Must be `true` only for a real, on-device computer-vision pipeline.
   * Manual marking is NOT a detector and must not be represented by this type.
   */
  readonly isAutomated: true;
  /** Load weights. Must fail loudly rather than pretending to work. */
  load(context: DetectorContext): Promise<void>;
  /** Return zero or more dart entry points. Never returns placeholder data. */
  detect(input: DetectInput): Promise<DartDetection[]>;
  dispose(): Promise<void>;
}

/**
 * The registry is intentionally empty: there is no detector available yet.
 * `runDetector` therefore always rejects, so no caller can accidentally treat
 * manual input as automated output.
 */
export const AVAILABLE_DETECTORS: readonly DartDetector[] = [];

export function getDetector(_id: string): DartDetector | null {
  return AVAILABLE_DETECTORS.find((d) => d.id === _id) ?? null;
}

export function hasAutomatedDetector(): boolean {
  return AVAILABLE_DETECTORS.length > 0;
}
