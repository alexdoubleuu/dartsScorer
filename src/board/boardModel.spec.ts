import { describe, expect, it } from 'vitest';
import {
  BOARD_MM,
  BOARD_UNIT_RADIUS_MM,
  SEGMENT_ANGLE_DEG,
  SEGMENT_ORDER_CLOCKWISE,
  boardPointFromPolar,
  boardPointToPolar,
  boardRadiusToMm,
  normaliseDegrees,
  ringFromRadiusMm,
  segmentNumberAtAngle,
  wedgeCentreAngleDeg,
  wedgeIndexAtAngle,
} from './boardModel';

describe('standard board dimensions', () => {
  it('matches the published steel-tip specification', () => {
    expect(BOARD_MM.playingAreaRadius).toBe(170);
    expect(BOARD_MM.doubleOuterRadius).toBe(170);
    expect(BOARD_MM.doubleInnerRadius).toBe(162);
    expect(BOARD_MM.trebleOuterRadius).toBe(107);
    expect(BOARD_MM.trebleInnerRadius).toBe(99);
    expect(BOARD_MM.outerBullRadius).toBe(15.9);
    expect(BOARD_MM.innerBullRadius).toBe(6.35);
    expect(BOARD_UNIT_RADIUS_MM).toBe(BOARD_MM.doubleOuterRadius);
  });

  it('has 8 mm wide double and treble rings', () => {
    expect(BOARD_MM.doubleOuterRadius - BOARD_MM.doubleInnerRadius).toBe(BOARD_MM.ringWidth);
    expect(BOARD_MM.trebleOuterRadius - BOARD_MM.trebleInnerRadius).toBe(BOARD_MM.ringWidth);
  });

  it('has the standard bull diameters', () => {
    expect(BOARD_MM.innerBullRadius * 2).toBeCloseTo(12.7, 9);
    expect(BOARD_MM.outerBullRadius * 2).toBeCloseTo(31.8, 9);
  });

  it('has twenty segments of 18 degrees', () => {
    expect(SEGMENT_ORDER_CLOCKWISE).toHaveLength(20);
    expect(SEGMENT_ANGLE_DEG).toBe(18);
  });
});

describe('segment order and orientation', () => {
  it('places 20 at 12 o clock', () => {
    const top = boardPointFromPolar(1, 0);
    expect(top.x).toBeCloseTo(0, 12);
    expect(top.y).toBeCloseTo(1, 12);
    expect(segmentNumberAtAngle(0)).toBe(20);
  });

  it('numbers clockwise: 6 at 3 o clock, 3 at 6 o clock, 11 at 9 o clock', () => {
    expect(segmentNumberAtAngle(90)).toBe(6);
    expect(segmentNumberAtAngle(180)).toBe(3);
    expect(segmentNumberAtAngle(270)).toBe(11);
  });

  it('uses the full standard clockwise sequence', () => {
    const expected = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
    expect([...SEGMENT_ORDER_CLOCKWISE]).toEqual(expected);
  });

  it('returns the correct number at the centre angle of all 20 wedges', () => {
    SEGMENT_ORDER_CLOCKWISE.forEach((expectedNumber, index) => {
      const centre = wedgeCentreAngleDeg(index);
      expect(centre).toBe(index * 18);
      expect(wedgeIndexAtAngle(centre)).toBe(index);
      expect(segmentNumberAtAngle(centre)).toBe(expectedNumber);

      // Sanity check the geometry, not just the lookup table.
      const p = boardPointFromPolar(0.8, centre);
      const polar = boardPointToPolar(p);
      expect(polar.angleFromTopClockwiseDeg).toBeCloseTo(centre, 9);
      expect(polar.radius).toBeCloseTo(0.8, 9);
    });
  });

  it('walks clockwise as the index increases', () => {
    for (let i = 0; i < 20; i += 1) {
      const here = boardPointFromPolar(1, wedgeCentreAngleDeg(i));
      const next = boardPointFromPolar(1, wedgeCentreAngleDeg(i + 1));
      // Cross product of (here x next) must be negative in the +X right / +Y up
      // board frame, which is the direction of a clockwise sweep.
      expect(here.x * next.y - here.y * next.x).toBeLessThan(0);
    }
  });

  it('normalises angles into [0, 360)', () => {
    expect(normaliseDegrees(-9)).toBe(351);
    expect(normaliseDegrees(360)).toBe(0);
    expect(normaliseDegrees(729)).toBeCloseTo(9, 9);
  });
});

describe('wedge boundaries either side of the wire', () => {
  const cases: Array<[number, number, number]> = [
    // angle, expected number just before, expected number at/after the wire
    [9, 20, 1], // 20/1
    [27, 1, 18],
    [99, 6, 10], // 6/10
    [189, 3, 19], // 3/19
    [279, 11, 14], // 11/14
    [351, 5, 20], // wraps past 0 back to 20
  ];

  it.each(cases)('at %d deg gives %d below the wire and %d on it', (angle, before, at) => {
    expect(segmentNumberAtAngle(angle - 0.000001)).toBe(before);
    expect(segmentNumberAtAngle(angle)).toBe(at);
    expect(segmentNumberAtAngle(angle + 0.000001)).toBe(at);
  });

  it('assigns the 20/1 wire at exactly 9 degrees to segment 1', () => {
    expect(wedgeIndexAtAngle(9)).toBe(1);
    expect(wedgeIndexAtAngle(8.999999)).toBe(0);
    expect(wedgeIndexAtAngle(351)).toBe(0);
    expect(wedgeIndexAtAngle(350.999999)).toBe(19);
  });
});

describe('ring bands', () => {
  it('classifies the interior of each band', () => {
    expect(ringFromRadiusMm(0)).toBe('inner-bull');
    expect(ringFromRadiusMm(3)).toBe('inner-bull');
    expect(ringFromRadiusMm(10)).toBe('outer-bull');
    expect(ringFromRadiusMm(50)).toBe('inner-single');
    expect(ringFromRadiusMm(103)).toBe('treble');
    expect(ringFromRadiusMm(130)).toBe('outer-single');
    expect(ringFromRadiusMm(166)).toBe('double');
  });

  it('is deterministic at every exact boundary (lower bound inclusive)', () => {
    expect(ringFromRadiusMm(6.35 - 1e-9)).toBe('inner-bull');
    expect(ringFromRadiusMm(6.35)).toBe('outer-bull');

    expect(ringFromRadiusMm(15.9 - 1e-9)).toBe('outer-bull');
    expect(ringFromRadiusMm(15.9)).toBe('inner-single');

    expect(ringFromRadiusMm(99 - 1e-9)).toBe('inner-single');
    expect(ringFromRadiusMm(99)).toBe('treble');

    expect(ringFromRadiusMm(107 - 1e-9)).toBe('treble');
    expect(ringFromRadiusMm(107)).toBe('outer-single');

    expect(ringFromRadiusMm(162 - 1e-9)).toBe('outer-single');
    expect(ringFromRadiusMm(162)).toBe('double');

    expect(ringFromRadiusMm(170 - 1e-9)).toBe('double');
    expect(ringFromRadiusMm(170)).toBe('off-board');
  });

  it('treats everything past the double ring as off board', () => {
    expect(ringFromRadiusMm(170.000001)).toBe('off-board');
    expect(ringFromRadiusMm(500)).toBe('off-board');
  });

  it('treats non-finite and negative radii as off board', () => {
    expect(ringFromRadiusMm(Number.NaN)).toBe('off-board');
    expect(ringFromRadiusMm(Number.POSITIVE_INFINITY)).toBe('off-board');
    expect(ringFromRadiusMm(-1)).toBe('off-board');
  });
});

describe('polar conversions', () => {
  it('round-trips board points', () => {
    for (let angle = 0; angle < 360; angle += 7.5) {
      for (const radius of [0.02, 0.1, 0.5, 0.95, 1]) {
        const p = boardPointFromPolar(radius, angle);
        const polar = boardPointToPolar(p);
        expect(polar.radius).toBeCloseTo(radius, 9);
        expect(polar.angleFromTopClockwiseDeg).toBeCloseTo(angle, 9);
      }
    }
  });

  it('keeps the normalised unit radius mapped to 170 mm', () => {
    expect(boardRadiusToMm(1)).toBe(170);
    expect(boardRadiusToMm(0.5)).toBe(85);
    expect(boardRadiusToMm(1) - boardRadiusToMm(0)).toBeCloseTo(BOARD_MM.doubleOuterRadius, 12);
  });
});
