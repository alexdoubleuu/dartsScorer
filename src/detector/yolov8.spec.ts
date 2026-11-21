import { describe, expect, it } from 'vitest';
import {
  LETTERBOX_PAD,
  decodeYolov8,
  letterboxGeometry,
  mapLetterboxedToSource,
  nonMaxSuppression,
  type RawDetection,
} from './yolov8';

const IMGSZ = 800;

/**
 * Build a YOLOv8-style output tensor [1, 4 + classCount, anchors] in the flat
 * row-major layout the runtime hands back, so the tests exercise the same
 * indexing the browser does.
 */
function buildOutput(
  anchors: Array<{ box: [number, number, number, number]; scores: number[] }>,
  classCount: number,
): Float32Array {
  const channels = 4 + classCount;
  const n = anchors.length;
  const data = new Float32Array(channels * n);
  anchors.forEach((anchor, index) => {
    data[0 * n + index] = anchor.box[0];
    data[1 * n + index] = anchor.box[1];
    data[2 * n + index] = anchor.box[2];
    data[3 * n + index] = anchor.box[3];
    anchor.scores.forEach((score, classId) => {
      data[(4 + classId) * n + index] = score;
    });
  });
  return data;
}

describe('letterboxGeometry', () => {
  it('leaves a square image untouched', () => {
    const geometry = letterboxGeometry({ width: 800, height: 800 }, IMGSZ);
    expect(geometry).toEqual({
      ratio: 1,
      left: 0,
      top: 0,
      newWidth: 800,
      newHeight: 800,
    });
  });

  it('pads a landscape image top and bottom', () => {
    const geometry = letterboxGeometry({ width: 1600, height: 800 }, IMGSZ);
    expect(geometry.ratio).toBe(0.5);
    expect(geometry).toMatchObject({ newWidth: 800, newHeight: 400, left: 0, top: 200 });
  });

  it('pads a portrait image left and right', () => {
    const geometry = letterboxGeometry({ width: 400, height: 800 }, IMGSZ);
    expect(geometry.ratio).toBe(1);
    expect(geometry).toMatchObject({ newWidth: 400, newHeight: 800, left: 200, top: 0 });
  });

  it('scales an oversized photo down so the long edge is imgsz', () => {
    const geometry = letterboxGeometry({ width: 2000, height: 1500 }, IMGSZ);
    expect(geometry.ratio).toBeCloseTo(0.4, 10);
    expect(geometry.newWidth).toBe(800);
    expect(geometry.newHeight).toBe(600);
    expect(geometry.top).toBe(100);
  });
});

describe('mapLetterboxedToSource', () => {
  it('inverts scaling and padding exactly', () => {
    // A 1600x800 photo becomes 800x400 at the top of the canvas.
    const geometry = letterboxGeometry({ width: 1600, height: 800 }, IMGSZ);
    // A dart at the left-centre of the letterboxed image sits at (100, 300).
    expect(mapLetterboxedToSource({ x: 100, y: 300 }, geometry)).toEqual({ x: 200, y: 200 });
  });

  it('round trips a source point through the letterbox', () => {
    const source = { width: 1234, height: 987 };
    const geometry = letterboxGeometry(source, IMGSZ);
    const original = { x: 400, y: 250 };
    const letterboxed = {
      x: original.x * geometry.ratio + geometry.left,
      y: original.y * geometry.ratio + geometry.top,
    };
    const back = mapLetterboxedToSource(letterboxed, geometry);
    expect(back.x).toBeCloseTo(original.x, 6);
    expect(back.y).toBeCloseTo(original.y, 6);
  });
});

describe('decodeYolov8', () => {
  const classCount = 7;

  it('picks the best class per anchor and applies the confidence threshold', () => {
    const output = buildOutput(
      [
        // A confident dart.
        { box: [100, 200, 20, 20], scores: [0, 0, 0, 0, 0.9, 0, 0] },
        // A confident calibration point (class 0), not a dart.
        { box: [400, 400, 20, 20], scores: [0.95, 0, 0, 0, 0.1, 0, 0] },
        // Below the threshold on every class.
        { box: [600, 600, 20, 20], scores: [0.05, 0, 0, 0, 0.04, 0, 0] },
      ],
      classCount,
    );

    const decoded = decodeYolov8(output, {
      channels: 4 + classCount,
      anchors: 3,
      classCount,
      confidenceThreshold: 0.25,
      iouThreshold: 0.5,
    });

    // Results come back strongest first.
    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toMatchObject({ classId: 0, cx: 400, cy: 400 });
    expect(decoded[0].confidence).toBeCloseTo(0.95, 5);
    expect(decoded[1]).toMatchObject({ classId: 4, cx: 100, cy: 200 });
    expect(decoded[1].confidence).toBeCloseTo(0.9, 5);
  });

  it('suppresses a weaker duplicate of the same class', () => {
    const output = buildOutput(
      [
        { box: [100, 100, 22, 22], scores: [0, 0, 0, 0, 0.8, 0, 0] },
        // Same place, slightly lower score: a duplicate, not a second dart.
        { box: [101, 101, 22, 22], scores: [0, 0, 0, 0, 0.6, 0, 0] },
      ],
      classCount,
    );

    const decoded = decodeYolov8(output, {
      channels: 4 + classCount,
      anchors: 2,
      classCount,
      confidenceThreshold: 0.25,
      iouThreshold: 0.5,
    });

    expect(decoded).toHaveLength(1);
    expect(decoded[0].confidence).toBeCloseTo(0.8, 5);
  });

  it('keeps overlapping boxes of different classes', () => {
    const output = buildOutput(
      [
        { box: [100, 100, 22, 22], scores: [0, 0, 0, 0, 0.8, 0, 0] },
        { box: [100, 100, 22, 22], scores: [0.7, 0, 0, 0, 0, 0, 0] },
      ],
      classCount,
    );

    const decoded = decodeYolov8(output, {
      channels: 4 + classCount,
      anchors: 2,
      classCount,
      confidenceThreshold: 0.25,
      iouThreshold: 0.5,
    });

    expect(decoded.map((d) => d.classId).sort()).toEqual([0, 4]);
  });

  it('rejects a tensor whose row count does not match the class count', () => {
    const output = buildOutput([{ box: [0, 0, 1, 1], scores: [0, 0, 0, 0, 1, 0, 0] }], classCount);
    expect(() =>
      decodeYolov8(output, {
        channels: 9,
        anchors: 1,
        classCount,
        confidenceThreshold: 0.25,
        iouThreshold: 0.5,
      }),
    ).toThrow(/rows/);
  });
});

describe('nonMaxSuppression', () => {
  const detection = (
    confidence: number,
    confidenceClass: number,
    cx: number,
    cy: number,
  ): RawDetection => ({
    cx,
    cy,
    width: 20,
    height: 20,
    confidence,
    classId: confidenceClass,
  });

  it('keeps the strongest of two near-identical boxes', () => {
    const kept = nonMaxSuppression([detection(0.4, 4, 50, 50), detection(0.9, 4, 51, 51)], 0.5);
    expect(kept).toHaveLength(1);
    expect(kept[0].confidence).toBe(0.9);
  });

  it('keeps boxes that do not overlap', () => {
    const kept = nonMaxSuppression([detection(0.9, 4, 50, 50), detection(0.8, 4, 500, 500)], 0.5);
    expect(kept).toHaveLength(2);
  });

  it('is stable: ties resolve in the order given', () => {
    const kept = nonMaxSuppression([detection(0.7, 4, 10, 10), detection(0.7, 4, 400, 400)], 0.5);
    expect(kept.map((d) => d.cx)).toEqual([10, 400]);
  });
});

describe('LETTERBOX_PAD', () => {
  it('matches the Ultralytics grey fill value', () => {
    expect(LETTERBOX_PAD).toBe(114);
  });
});
