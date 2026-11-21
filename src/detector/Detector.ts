import type { Point, Size } from '../types';
import { createYolov8DartDetector } from './yolov8Detector';

/**
 * ---------------------------------------------------------------------------
 * AUTOMATIC DETECTOR BOUNDARY
 * ---------------------------------------------------------------------------
 * `yolov8Detector.ts` is a real, on-device detector: a trained YOLOv8 model
 * run with onnxruntime-web from a file bundled with this app. It is listed in
 * `AVAILABLE_DETECTORS` below, so `hasAutomatedDetector()` is now true and the
 * UI may honestly claim detection is available.
 *
 * The interface still exists for a reason: a detector that returns placeholder
 * boxes, a mock, or a hand-entered tap is NOT a detector, and must never be
 * registered here. Manual marking continues to be a separate, explicitly
 * labelled mode.
 *
 * DESIGN NOTE - why entry points, not bounding boxes:
 * Scoring needs the exact point at which the dart tip meets the board face.
 * A bounding box describes where a dart is in the image, which is almost
 * useless for scoring: the box centroid of a dart lying across the 20 wire is
 * nowhere near its entry point. A detector must therefore report a single
 * board-entry coordinate per dart, plus an optional confidence.
 *
 * EVIDENCE - what these weights actually annotate:
 * The `dart-sense` training labels are point annotations, not object extents.
 * Every box in the dataset labels has the identical tiny size (w = h = 0.025
 * of the image, about 20 px at 800), for the dart class and for the printed
 * number-glyph classes alike. The model author's own scoring script reads a
 * dart's position as that box's CENTRE (`box.xywhn` -> x_centre, y_centre), see
 * `.ml-lab/reference_predict.py`. So for these weights the box centre IS the
 * annotated dart landing point, which is exactly what `DartDetection.point`
 * must carry - and taking the centre is correct, not an approximation.
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

export interface DetectorTraceCandidate {
  anchor: number;
  confidence: number;
  winningClassId: number;
  disposition: 'below-confidence' | 'other-class-wins' | 'nms-suppressed' | 'retained';
  suppressedByAnchor?: number;
  /** Model-input coordinates, before inverse letterboxing. */
  boxLetterboxed: { left: number; top: number; right: number; bottom: number };
  /** Box centre and extent mapped back to the source image. */
  point: Point;
  boxSource: { left: number; top: number; right: number; bottom: number };
}

export interface DetectorTrace {
  debugThreshold: number;
  productionConfidenceThreshold: number;
  iouThreshold: number;
  inputSize: number;
  classId: number;
  className: string;
  preprocessing: {
    colorSpace: 'RGB';
    scale: '0..1';
    letterboxPad: number;
    layout: 'NCHW';
  };
  timings: {
    preprocessingMs: number;
    inferenceMs: number;
    postprocessingMs: number;
  };
  candidates: DetectorTraceCandidate[];
}

export type DetectorSettings = Omit<DetectorTrace, 'candidates' | 'timings'>;

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
  /** Optional trace captured from the most recent inference for debug export. */
  getLastTrace?(): DetectorTrace | null;
  /** Optional immutable runtime settings, available even if inference fails. */
  getSettings?(): DetectorSettings;
  /** Clear any previous-photo trace before starting another Detect press. */
  clearLastTrace?(): void;
  dispose(): Promise<void>;
}

/**
 * The detectors this build can actually run. Currently one: the bundled
 * YOLOv8 model. Its weights and wasm backend load lazily on first `load()`.
 */
export const AVAILABLE_DETECTORS: readonly DartDetector[] = [createYolov8DartDetector()];

/** The detector used when the user presses Detect. */
export const DEFAULT_DETECTOR_ID = 'yolov8-dart-sense-onnx-800';

export function getDetector(_id: string): DartDetector | null {
  return AVAILABLE_DETECTORS.find((d) => d.id === _id) ?? null;
}

export function hasAutomatedDetector(): boolean {
  return AVAILABLE_DETECTORS.length > 0;
}
