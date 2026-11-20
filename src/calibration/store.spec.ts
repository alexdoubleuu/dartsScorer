import { describe, expect, it } from 'vitest';
import { assessReuse, rescaleRefPoints, type StoredCalibration } from './store';

function stored(overrides: Partial<StoredCalibration> = {}): StoredCalibration {
  return {
    version: 1,
    refPoints: [
      { x: 100, y: 100 },
      { x: 900, y: 120 },
      { x: 880, y: 480 },
      { x: 120, y: 460 },
    ],
    imageSize: { width: 1000, height: 500 },
    camera: { deviceId: 'rear-1', label: 'Rear camera' },
    savedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('assessReuse', () => {
  it('allows reuse when shape, resolution and camera all match', () => {
    const result = assessReuse(
      stored(),
      { width: 1000, height: 500 },
      { deviceId: 'rear-1', label: 'Rear camera' },
    );
    expect(result.reusable).toBe(true);
    expect(result.blockers).toHaveLength(0);
    expect(result.notes).toHaveLength(0);
  });

  it('blocks reuse when the aspect ratio differs beyond tolerance', () => {
    const result = assessReuse(
      stored(),
      { width: 1000, height: 1000 },
      { deviceId: 'rear-1', label: 'Rear camera' },
    );
    expect(result.reusable).toBe(false);
    expect(result.blockers[0]).toMatch(/shape/i);
  });

  it('blocks reuse when the camera device differs', () => {
    const result = assessReuse(
      stored(),
      { width: 1000, height: 500 },
      { deviceId: 'front-2', label: 'Front camera' },
    );
    expect(result.reusable).toBe(false);
    expect(result.blockers).toContain('This is a different camera.');
  });

  it('keeps reuse allowed but notes an unknown camera', () => {
    const result = assessReuse(stored(), { width: 1000, height: 500 }, null);
    expect(result.reusable).toBe(true);
    expect(result.notes.join(' ')).toMatch(/camera could not be identified/i);
  });

  it('keeps reuse allowed but notes a resolution change with the same shape', () => {
    const result = assessReuse(
      stored(),
      { width: 2000, height: 1000 },
      { deviceId: 'rear-1', label: 'Rear camera' },
    );
    expect(result.reusable).toBe(true);
    expect(result.notes.join(' ')).toMatch(/resolution changed/i);
  });
});

describe('rescaleRefPoints', () => {
  it('scales the reference points proportionally', () => {
    const scaled = rescaleRefPoints(stored(), { width: 2000, height: 1000 });
    expect(scaled).toEqual([
      { x: 200, y: 200 },
      { x: 1800, y: 240 },
      { x: 1760, y: 960 },
      { x: 240, y: 920 },
    ]);
  });

  it('returns the points unchanged when the stored size is invalid', () => {
    const scaled = rescaleRefPoints(stored({ imageSize: { width: 0, height: 0 } }), {
      width: 800,
      height: 400,
    });
    expect(scaled).toEqual(stored().refPoints);
  });
});
