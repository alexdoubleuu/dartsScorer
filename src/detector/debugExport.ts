import type { Frame } from '../camera/frame';
import { CALIBRATION_REFS, type Calibration } from '../geometry/calibration';
import { boardNumberLabels, boardRingShapes, boardWireShapes } from '../overlay/boardOverlay';
import type { DetectorSettings, DetectorTrace } from './Detector';
import type { Point } from '../types';

/**
 * ---------------------------------------------------------------------------
 * DETECTION DIAGNOSTICS AND DEBUG EXPORT
 * ---------------------------------------------------------------------------
 * Everything a phone test needs to judge a Detect press away from a laptop:
 * the source resolution, how long the model took to load versus how long the
 * inference itself took, how many darts the model proposed, and a file the
 * tester can download afterwards.
 *
 * One self-contained JSON case is produced. It embeds the analysed photo, the
 * calibration and detector settings, all candidate/filter decisions, the
 * current scored markers, and a PNG overlay as a data URL.
 *
 * The overlay uses the app's own board geometry. Candidate boxes and centres
 * are drawn on the photo, with a side legend so overlapping labels stay legible.
 */

/** One detection the model proposed, whether or not it was kept. */
export interface DetectionCandidate {
  markerId: string | null;
  /** Entry point in source-image pixels, the same grid as calibration. */
  point: Point;
  /** The same point as a 0..1 fraction of the image, for offline cross-checks. */
  norm: Point;
  confidence: number | null;
}

/** The full record of one Detect press. */
export interface DetectionDiagnostics {
  detectorName: string;
  imageWidth: number;
  imageHeight: number;
  /** Fetch + initialise the model and wasm backend. 0 when already loaded. */
  modelLoadMs: number;
  /** Time in the ONNX Runtime session.run call itself. */
  inferenceMs: number;
  preprocessingMs: number;
  postprocessingMs: number;
  /** Time from Detect press through the first rendered result update. */
  totalMs: number;
  /** Class-4 candidates at or above the low debug threshold. */
  candidateCount: number;
  /** Candidates retained by production confidence filtering and NMS. */
  retainedCount: number;
  /** Production-retained points. */
  candidates: DetectionCandidate[];
  /** Runtime errors surfaced during the press, in order. */
  errors: string[];
}

export interface DebugCaseMarker {
  id: string;
  origin: 'detector' | 'manual';
  point: Point;
  score: {
    label: string;
    points: number;
    segment: number | 'BULL' | 'MISS';
    multiplier: number;
    ring: string;
  } | null;
  corrected: boolean;
}

export interface DebugCaseInput {
  frame: Frame;
  calibration: Calibration;
  diagnostics: DetectionDiagnostics;
  detectorId: string;
  detectorName: string;
  settings: DetectorSettings | null;
  trace: DetectorTrace | null;
  markers: DebugCaseMarker[];
}

/** Self-contained case file intended to be shared for offline diagnosis. */
export interface DebugCase {
  schema: 'darts-scorer-debug-case/v1';
  createdAt: string;
  sourceImage: {
    dataUrl: string;
    mimeType: string;
    origin: Frame['origin'];
    width: number;
    height: number;
  };
  imageSize: { width: number; height: number };
  calibration: {
    imageSize: Calibration['imageSize'];
    residual: number;
    refPoints: Array<{
      order: number;
      id: string;
      label: string;
      point: Point;
    }>;
    imageToBoard: Calibration['imageToBoard'];
    boardToImage: Calibration['boardToImage'];
  };
  detector: {
    id: string;
    name: string;
    modelFile: string;
    settings: DetectorSettings | null;
    trace: DetectorTrace | null;
  };
  debugOverlay: {
    dataUrl: string;
    mimeType: 'image/png';
  } | null;
  diagnostics: DetectionDiagnostics;
  predictions: {
    retained: DetectionDiagnostics['candidates'];
    scoredMarkers: DebugCaseMarker[];
  };
}

async function frameDataUrl(frame: Frame): Promise<{ dataUrl: string; mimeType: string }> {
  let blob: Blob;
  try {
    const response = await fetch(frame.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    blob = await response.blob();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `The analysed photo is no longer available (${detail}). Upload or capture it again in the app, recalibrate, and press Detect before saving the debug case.`,
    );
  }
  if (!blob.size) {
    throw new Error(
      'The analysed photo is empty. Upload or capture it again in the app, recalibrate, and press Detect before saving the debug case.',
    );
  }

  const dataUrl = await blobDataUrl(blob);
  return { dataUrl, mimeType: blob.type || 'application/octet-stream' };
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not package debug image data.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Could not package debug image data.'));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Bundle the exact analysed frame and all app-side context in one JSON file.
 * The blob URL is fetched immediately so the photo survives after navigation.
 */
export async function buildDebugCase(input: DebugCaseInput): Promise<DebugCase> {
  const image = await frameDataUrl(input.frame);
  const overlay = await buildOverlayPng(
    input.frame,
    input.calibration,
    input.diagnostics,
    input.trace,
  );
  return {
    schema: 'darts-scorer-debug-case/v1',
    createdAt: new Date().toISOString(),
    sourceImage: {
      ...image,
      origin: input.frame.origin,
      width: input.frame.width,
      height: input.frame.height,
    },
    imageSize: { width: input.frame.width, height: input.frame.height },
    calibration: {
      imageSize: { ...input.calibration.imageSize },
      residual: input.calibration.residual,
      refPoints: input.calibration.refPoints.map((point, index) => ({
        order: index + 1,
        id: CALIBRATION_REFS[index]?.id ?? `unknown-${index + 1}`,
        label: CALIBRATION_REFS[index]?.label ?? `Reference ${index + 1}`,
        point: { ...point },
      })),
      imageToBoard: input.calibration.imageToBoard,
      boardToImage: input.calibration.boardToImage,
    },
    detector: {
      id: input.detectorId,
      name: input.detectorName,
      modelFile: 'models/dart-detector.onnx',
      settings: input.settings,
      trace: input.trace,
    },
    debugOverlay: {
      dataUrl: await blobDataUrl(overlay),
      mimeType: 'image/png',
    },
    diagnostics: input.diagnostics,
    predictions: {
      retained: input.diagnostics.candidates,
      scoredMarkers: input.markers,
    },
  };
}

export function debugCaseToJson(debugCase: DebugCase): string {
  return JSON.stringify(debugCase, null, 2);
}

function loadFrameImage(frame: Frame): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'sync';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The photo could not be decoded for the debug overlay.'));
    image.src = frame.url;
  });
}

/**
 * Draw the photo, the projected board and every detection candidate into a PNG.
 *
 * The board rings and wires are the app's own overlay paths, replayed through
 * `Path2D`, so a ring that sits on the real wire on screen sits on it here too.
 */
export async function buildOverlayPng(
  frame: Frame,
  calibration: Calibration | null,
  diagnostics: DetectionDiagnostics,
  trace: DetectorTrace | null = null,
): Promise<Blob> {
  const image = await loadFrameImage(frame);
  const unit = Math.max(1, frame.width / 800);
  const panelWidth = trace ? 360 * unit : 0;
  const rowHeight = 20 * unit;
  const panelTop = 58 * unit;
  const orderedTrace = trace
    ? [...trace.candidates].sort((a, b) => b.confidence - a.confidence)
    : [];
  const canvas = document.createElement('canvas');
  canvas.width = frame.width + panelWidth;
  canvas.height = Math.max(
    frame.height,
    trace ? panelTop + orderedTrace.length * rowHeight + 12 * unit : frame.height,
  );
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a canvas for the debug overlay.');
  context.fillStyle = '#0d1117';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, frame.width, frame.height);

  if (calibration) {
    context.save();
    context.lineWidth = unit;
    context.strokeStyle = 'rgba(88, 166, 255, 0.85)';
    for (const shape of [...boardRingShapes(calibration), ...boardWireShapes(calibration)]) {
      context.stroke(new Path2D(shape.d));
    }
    context.fillStyle = 'rgba(255, 255, 255, 0.9)';
    context.font = `${12 * unit}px sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (const label of boardNumberLabels(calibration)) {
      context.fillText(String(label.number), label.point.x, label.point.y);
    }
    context.fillStyle = 'rgba(255, 210, 0, 0.95)';
    for (const ref of calibration.refPoints) {
      context.beginPath();
      context.arc(ref.x, ref.y, 5 * unit, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  const radius = 6 * unit;
  context.save();
  context.font = `bold ${14 * unit}px sans-serif`;
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  const colorFor = (disposition: DetectorTrace['candidates'][number]['disposition']) => {
    switch (disposition) {
      case 'retained':
        return '#3fb950';
      case 'nms-suppressed':
        return '#f85149';
      case 'below-confidence':
        return '#d29922';
      case 'other-class-wins':
        return '#a371f7';
    }
  };
  if (trace) {
    orderedTrace.forEach((candidate, index) => {
      const color = colorFor(candidate.disposition);
      const { left, top, right, bottom } = candidate.boxSource;
      const { x, y } = candidate.point;
      context.lineWidth = 2 * unit;
      context.strokeStyle = color;
      context.strokeRect(left, top, right - left, bottom - top);
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.moveTo(x - radius * 1.7, y);
      context.lineTo(x + radius * 1.7, y);
      context.moveTo(x, y - radius * 1.7);
      context.lineTo(x, y + radius * 1.7);
      context.stroke();

      const tag = `#${index + 1}`;
      const tagWidth = context.measureText(tag).width + 8 * unit;
      const tagX = Math.max(0, Math.min(left, frame.width - tagWidth));
      const tagY = Math.max(10 * unit, Math.min(top + 8 * unit, frame.height - 10 * unit));
      context.fillStyle = color;
      context.fillRect(tagX, tagY - 9 * unit, tagWidth, 18 * unit);
      context.fillStyle = '#0d1117';
      context.fillText(tag, tagX + 4 * unit, tagY);
    });

    const panelX = frame.width;
    context.fillStyle = '#161b22';
    context.fillRect(panelX, 0, panelWidth, canvas.height);
    context.fillStyle = '#f0f6fc';
    context.font = `bold ${14 * unit}px sans-serif`;
    context.fillText(`Class 4 candidates (debug >= ${trace.debugThreshold})`, panelX + 12 * unit, 18 * unit);
    context.font = `${11 * unit}px sans-serif`;
    context.fillStyle = '#8b949e';
    context.fillText('Boxes and centres use source-image pixels.', panelX + 12 * unit, 38 * unit);

    orderedTrace.forEach((candidate, index) => {
      const color = colorFor(candidate.disposition);
      const y = panelTop + index * rowHeight;
      context.fillStyle = color;
      context.fillRect(panelX + 12 * unit, y - 5 * unit, 8 * unit, 8 * unit);
      context.fillStyle = '#f0f6fc';
      context.font = `${11 * unit}px sans-serif`;
      const pointText = `(${candidate.point.x.toFixed(1)}, ${candidate.point.y.toFixed(1)})`;
      const text =
        `#${index + 1}  c=${candidate.confidence.toFixed(3)}  ` +
        `${candidate.disposition}  ${pointText}`;
      context.fillText(text, panelX + 26 * unit, y);
    });
  } else {
    context.lineWidth = 2 * unit;
    context.strokeStyle = 'rgba(248, 81, 73, 0.95)';
    diagnostics.candidates.forEach((candidate, index) => {
      const { x, y } = candidate.point;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.moveTo(x - radius * 1.7, y);
      context.lineTo(x + radius * 1.7, y);
      context.moveTo(x, y - radius * 1.7);
      context.lineTo(x, y + radius * 1.7);
      context.stroke();

      const text = `#${index + 1} ${candidate.confidence === null ? 'n/a' : candidate.confidence.toFixed(2)}`;
      const textX = x + radius * 1.9;
      const textY = y - radius * 1.9;
      const width = context.measureText(text).width;
      context.fillStyle = 'rgba(0, 0, 0, 0.65)';
      context.fillRect(textX, textY - 10 * unit, width + 8 * unit, 20 * unit);
      context.fillStyle = '#ffdd57';
      context.fillText(text, textX + 4 * unit, textY);
    });
  }
  context.restore();

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the debug overlay.'))),
      'image/png',
    );
  });
}

/** Serialise the diagnostics, including every candidate coordinate. */
export function diagnosticsToJson(diagnostics: DetectionDiagnostics): string {
  return JSON.stringify(diagnostics, null, 2);
}

/** Hand a blob to the browser as a download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
