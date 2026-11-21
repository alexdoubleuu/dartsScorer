import type { InferenceSession } from 'onnxruntime-web';
import type {
  DartDetection,
  DartDetector,
  DetectorContext,
  DetectorSettings,
  DetectorTrace,
  DetectInput,
} from './Detector';
import {
  LETTERBOX_PAD,
  decodeYolov8,
  letterboxGeometry,
  mapLetterboxedToSource,
  traceDartCandidates,
  type LetterboxGeometry,
} from './yolov8';
import { BOARD_CROP_PAD, cropToSourcePoint, type CropRect } from './crop';

/**
 * ---------------------------------------------------------------------------
 * YOLOv8 DART DETECTOR (REAL, ON-DEVICE)
 * ---------------------------------------------------------------------------
 * Runs a trained YOLOv8 model in the browser with onnxruntime-web and turns
 * its output into the single thing scoring needs: the point where each dart
 * entered the board face, in source-image pixel coordinates.
 *
 * Model: `dart-sense` (Ben Willshaw, CC BY-NC 4.0), exported to ONNX here at
 * imgsz 800 / opset 12. Classes are
 *   {0:'20', 1:'3', 2:'11', 3:'6', 4:'dart', 5:'9', 6:'15'}.
 * Only class 4 is used: this app keeps its own four-point calibration, so the
 * model's calibration classes are ignored rather than mixed with it.
 *
 * Everything is loaded lazily: onnxruntime-web and the ~11 MB wasm backend are
 * only fetched when `load()` is first called, so the app still starts on a
 * phone without paying for a model nobody has asked to run.
 */

type Ort = typeof import('onnxruntime-web');

const MODEL_URL = `${import.meta.env.BASE_URL}models/dart-detector.onnx`;
const WASM_DIR = `${import.meta.env.BASE_URL}ort/`;

/** Square input side the model was exported at. */
const IMGSZ = 800;
/** Class index of "dart" in this checkpoint. */
const DART_CLASS = 4;
/**
 * Ultralytics' own `predict()` defaults, which are what the model author's
 * pipeline (`get_scores.py`) relies on. Keeping the same two numbers here is
 * what makes the browser output comparable with the reference run in
 * `.ml-lab/reference_predict.py`.
 */
const DART_CONFIDENCE = 0.25;
const IOU_THRESHOLD = 0.7;
const DEBUG_CONFIDENCE = 0.01;

class Yolov8DartDetector implements DartDetector {
  readonly id = 'yolov8-dart-sense-onnx-800';
  readonly name = 'Dart detector (YOLOv8, on device)';
  readonly isAutomated = true as const;

  private ort: Ort | null = null;
  private session: InferenceSession | null = null;
  private loading: Promise<void> | null = null;
  private lastTrace: DetectorTrace | null = null;

  async load(_context: DetectorContext): Promise<void> {
    if (this.session) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      let ort: Ort;
      try {
        ort = await import('onnxruntime-web');
      } catch (cause) {
        throw new Error(
          `Could not load the inference runtime (onnxruntime-web): ${messageOf(cause)}`,
        );
      }

      // A single-threaded wasm backend needs no SharedArrayBuffer, so it works
      // on a plain static host and on a phone without cross-origin isolation.
      ort.env.wasm.wasmPaths = WASM_DIR;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;

      try {
        this.session = await ort.InferenceSession.create(MODEL_URL, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });
      } catch (cause) {
        throw new Error(
          `Could not load the dart detection model from ${MODEL_URL}: ${messageOf(cause)}`,
        );
      }
      this.ort = ort;
    })();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async detect(input: DetectInput): Promise<DartDetection[]> {
    const ort = this.ort;
    const session = this.session;
    if (!ort || !session) throw new Error('Detector used before load() finished.');
    this.clearLastTrace();

    const crop = input.crop ?? null;
    const region = crop ? { width: crop.width, height: crop.height } : input.imageSize;

    const preprocessingStart = performance.now();
    const geometry = letterboxGeometry(region, IMGSZ);
    const values = buildInputTensor(input, crop, geometry);
    const tensor = new ort.Tensor('float32', values, [1, 3, IMGSZ, IMGSZ]);
    const preprocessingMs = performance.now() - preprocessingStart;

    const inputName = session.inputNames[0];
    const inferenceStart = performance.now();
    const results = await session.run({ [inputName]: tensor });
    const inferenceMs = performance.now() - inferenceStart;
    const output = results[session.outputNames[0]];

    const postprocessingStart = performance.now();
    const dims = output.dims as [number, number, number];
    const channels = dims[1];
    const anchors = dims[2];

    const decodeOptions = {
      channels,
      anchors,
      classCount: channels - 4,
      confidenceThreshold: DART_CONFIDENCE,
      iouThreshold: IOU_THRESHOLD,
    };
    const outputData = output.data as Float32Array;
    const raw = decodeYolov8(outputData, decodeOptions);
    const traceCandidates = traceDartCandidates(
      outputData,
      decodeOptions,
      DART_CLASS,
      DEBUG_CONFIDENCE,
    );
    const detections = raw
      .filter((candidate) => candidate.classId === DART_CLASS)
      .map((candidate) => ({
        // These weights annotate each dart as a tiny point box whose centre is
        // the dart's landing point - the author's own pipeline reads that
        // centre from `box.xywhn` (`reference_predict.py`).
        //
        // The inverse transform is the whole letterbox chain in reverse: undo
        // the letterbox scale and padding to recover crop-local pixels, then add
        // the crop origin to return to source-image pixels. With no crop the
        // second step is the identity.
        point: cropToSourcePoint(
          mapLetterboxedToSource({ x: candidate.cx, y: candidate.cy }, geometry),
          crop,
        ),
        confidence: candidate.confidence,
        tailHint: null,
      }));
    const postprocessingMs = performance.now() - postprocessingStart;

    this.lastTrace = {
      ...this.getSettings(),
      frame: {
        mode: input.frameMode ?? (crop ? 'board-crop' : 'full'),
        cropRect: crop ? { ...crop } : null,
        padRatio: BOARD_CROP_PAD,
      },
      timings: {
        preprocessingMs,
        inferenceMs,
        postprocessingMs,
      },
      candidates: traceCandidates.map((candidate) => {
        const point = cropToSourcePoint(
          mapLetterboxedToSource(
            { x: candidate.cx, y: candidate.cy },
            geometry,
          ),
          crop,
        );
        return {
          anchor: candidate.anchor,
          confidence: candidate.confidence,
          winningClassId: candidate.winningClassId,
          disposition: candidate.disposition,
          ...(candidate.suppressedByAnchor === undefined
            ? {}
            : { suppressedByAnchor: candidate.suppressedByAnchor }),
          boxLetterboxed: {
            left: candidate.cx - candidate.width / 2,
            top: candidate.cy - candidate.height / 2,
            right: candidate.cx + candidate.width / 2,
            bottom: candidate.cy + candidate.height / 2,
          },
          point,
          boxSource: {
            left: (candidate.cx - candidate.width / 2 - geometry.left) / geometry.ratio + (crop?.x ?? 0),
            top: (candidate.cy - candidate.height / 2 - geometry.top) / geometry.ratio + (crop?.y ?? 0),
            right: (candidate.cx + candidate.width / 2 - geometry.left) / geometry.ratio + (crop?.x ?? 0),
            bottom: (candidate.cy + candidate.height / 2 - geometry.top) / geometry.ratio + (crop?.y ?? 0),
          },
        };
      }),
    };

    return detections;
  }

  getLastTrace(): DetectorTrace | null {
    return this.lastTrace;
  }

  getSettings(): DetectorSettings {
    return {
      debugThreshold: DEBUG_CONFIDENCE,
      productionConfidenceThreshold: DART_CONFIDENCE,
      iouThreshold: IOU_THRESHOLD,
      inputSize: IMGSZ,
      classId: DART_CLASS,
      className: 'dart',
      preprocessing: {
        colorSpace: 'RGB',
        scale: '0..1',
        letterboxPad: LETTERBOX_PAD,
        layout: 'NCHW',
      },
    };
  }

  clearLastTrace(): void {
    this.lastTrace = null;
  }

  async dispose(): Promise<void> {
    await this.session?.release();
    this.session = null;
    this.ort = null;
    this.lastTrace = null;
  }
}

/**
 * Letterbox the (optionally cropped) source pixels into a square RGB tensor,
 * exactly as the reference implementation does: scale to fit, centre on a grey
 * 114 canvas, convert to 0..1 and lay channels out planar (NCHW).
 *
 * When `crop` is given only that sub-rectangle of the photo is scaled into the
 * canvas, so the board fills far more of the input than it would letterboxed
 * whole. `geometry` is computed from the crop's own size, which keeps the
 * aspect ratio unchanged.
 */
function buildInputTensor(
  input: DetectInput,
  crop: CropRect | null,
  geometry: LetterboxGeometry,
): Float32Array {
  const source = document.createElement('canvas');
  source.width = input.imageSize.width;
  source.height = input.imageSize.height;
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('Could not get a 2D canvas context to preprocess the photo.');
  sourceContext.putImageData(input.imageData, 0, 0);

  const canvas = document.createElement('canvas');
  canvas.width = IMGSZ;
  canvas.height = IMGSZ;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Could not get a 2D canvas context to preprocess the photo.');
  context.fillStyle = `rgb(${LETTERBOX_PAD}, ${LETTERBOX_PAD}, ${LETTERBOX_PAD})`;
  context.fillRect(0, 0, IMGSZ, IMGSZ);
  const region = crop ?? { x: 0, y: 0, width: input.imageSize.width, height: input.imageSize.height };
  context.drawImage(
    source,
    region.x,
    region.y,
    region.width,
    region.height,
    geometry.left,
    geometry.top,
    geometry.newWidth,
    geometry.newHeight,
  );

  const { data } = context.getImageData(0, 0, IMGSZ, IMGSZ);
  const plane = IMGSZ * IMGSZ;
  const values = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i += 1) {
    values[i] = data[i * 4] / 255;
    values[plane + i] = data[i * 4 + 1] / 255;
    values[2 * plane + i] = data[i * 4 + 2] / 255;
  }
  return values;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Build the detector. The session is created only when `load()` is called. */
export function createYolov8DartDetector(): DartDetector {
  return new Yolov8DartDetector();
}
