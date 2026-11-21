import type { Frame } from '../camera/frame';
import type { Calibration } from '../geometry/calibration';
import { boardNumberLabels, boardRingShapes, boardWireShapes } from '../overlay/boardOverlay';
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
 * Two artefacts are produced:
 *   - a PNG overlay of the photo with the projected board, the detection
 *     candidates, their index and their confidence, and
 *   - a JSON record of every candidate in both image pixels and normalised
 *     coordinates, so predictions can be compared against entry points that
 *     were checked independently by eye rather than only against the model.
 *
 * The overlay is drawn at the source resolution and uses the app's own board
 * overlay geometry, so it lines up with what the screen showed.
 */

/** One detection the model proposed, whether or not it was kept. */
export interface DetectionCandidate {
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
  /** `session.run` plus output decoding only - the cost of one inference. */
  inferenceMs: number;
  /** The whole press: preprocess, load, inference, decode. */
  totalMs: number;
  /** Darts the model proposed on this photo. */
  candidateCount: number;
  /** Darts kept as scored markers when the press finished. */
  retainedCount: number;
  candidates: DetectionCandidate[];
  /** Runtime errors surfaced during the press, in order. */
  errors: string[];
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
): Promise<Blob> {
  const image = await loadFrameImage(frame);
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a canvas for the debug overlay.');
  context.drawImage(image, 0, 0, frame.width, frame.height);

  const unit = Math.max(1, frame.width / 800);

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
  context.lineWidth = 2 * unit;
  context.strokeStyle = 'rgba(248, 81, 73, 0.95)';
  context.font = `bold ${14 * unit}px sans-serif`;
  context.textAlign = 'left';
  context.textBaseline = 'middle';
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
