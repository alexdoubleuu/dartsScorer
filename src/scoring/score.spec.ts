import { describe, expect, it } from 'vitest';
import {
  BOARD_UNIT_RADIUS_MM,
  SEGMENT_ORDER_CLOCKWISE,
  boardPointFromPolar,
  boardPointToPolar,
} from '../board/boardModel';
import { scoreBoardPoint, sumScores } from './score';

/** Build a board point from a radius in mm at a given angle. */
const at = (radiusMm: number, angleDeg = 0) =>
  boardPointFromPolar(radiusMm / BOARD_UNIT_RADIUS_MM, angleDeg);

describe('numbered wedges', () => {
  it('scores a single at the centre of every wedge', () => {
    SEGMENT_ORDER_CLOCKWISE.forEach((number, index) => {
      const score = scoreBoardPoint(at(85, index * 18));
      expect(score).toEqual({
        segment: number,
        multiplier: 1,
        score: number,
        label: `S${number}`,
        ring: 'inner-single',
      });
    });
  });

  it('scores an outer single between the treble and double rings', () => {
    expect(scoreBoardPoint(at(130, 0))).toEqual({
      segment: 20,
      multiplier: 1,
      score: 20,
      label: 'S20',
      ring: 'outer-single',
    });
  });

  it('scores all 20 doubles and trebles', () => {
    SEGMENT_ORDER_CLOCKWISE.forEach((number, index) => {
      const angle = index * 18;
      expect(scoreBoardPoint(at(166, angle))).toEqual({
        segment: number,
        multiplier: 2,
        score: number * 2,
        label: `D${number}`,
        ring: 'double',
      });
      expect(scoreBoardPoint(at(103, angle))).toEqual({
        segment: number,
        multiplier: 3,
        score: number * 3,
        label: `T${number}`,
        ring: 'treble',
      });
    });
  });
});

describe('bullseyes', () => {
  it('scores the inner bull as 50', () => {
    expect(scoreBoardPoint({ x: 0, y: 0 })).toEqual({
      segment: 'BULL',
      multiplier: 1,
      score: 50,
      label: 'BULL',
      ring: 'inner-bull',
    });
    expect(scoreBoardPoint(at(3, 137)).score).toBe(50);
  });

  it('scores the outer bull as 25', () => {
    expect(scoreBoardPoint(at(10, 22))).toEqual({
      segment: 'BULL',
      multiplier: 1,
      score: 25,
      label: '25',
      ring: 'outer-bull',
    });
  });
});

describe('misses', () => {
  it('scores zero beyond the outer double ring', () => {
    expect(scoreBoardPoint(at(171, 0))).toEqual({
      segment: 'MISS',
      multiplier: 1,
      score: 0,
      label: 'MISS',
      ring: 'off-board',
    });
    expect(scoreBoardPoint(at(400, 275)).score).toBe(0);
  });

  it('scores zero for a non-finite board point rather than throwing', () => {
    expect(scoreBoardPoint({ x: Number.NaN, y: 0 }).score).toBe(0);
    expect(scoreBoardPoint({ x: 0, y: Number.POSITIVE_INFINITY }).score).toBe(0);
  });
});

describe('boundaries, expressed as offsets that are far larger than float noise', () => {
  const halfMm = 0.5;

  it('resolves ring boundaries either side', () => {
    expect(scoreBoardPoint(at(15.9 - halfMm, 0)).ring).toBe('outer-bull');
    expect(scoreBoardPoint(at(15.9 + halfMm, 0)).ring).toBe('inner-single');

    expect(scoreBoardPoint(at(99 - halfMm, 0)).ring).toBe('inner-single');
    expect(scoreBoardPoint(at(99 + halfMm, 0)).multiplier).toBe(3);

    expect(scoreBoardPoint(at(107 - halfMm, 0)).multiplier).toBe(3);
    expect(scoreBoardPoint(at(107 + halfMm, 0)).multiplier).toBe(1);

    expect(scoreBoardPoint(at(162 - halfMm, 0)).multiplier).toBe(1);
    expect(scoreBoardPoint(at(162 + halfMm, 0)).multiplier).toBe(2);

    expect(scoreBoardPoint(at(170 - halfMm, 0)).label).toBe('D20');
    expect(scoreBoardPoint(at(170 + halfMm, 0)).label).toBe('MISS');
  });

  it('resolves wedge boundaries either side', () => {
    expect(scoreBoardPoint(at(60, 9 - 0.05)).segment).toBe(20);
    expect(scoreBoardPoint(at(60, 9 + 0.05)).segment).toBe(1);

    expect(scoreBoardPoint(at(60, 99 - 0.05)).segment).toBe(6);
    expect(scoreBoardPoint(at(60, 99 + 0.05)).segment).toBe(10);

    expect(scoreBoardPoint(at(60, 189 - 0.05)).segment).toBe(3);
    expect(scoreBoardPoint(at(60, 189 + 0.05)).segment).toBe(19);

    expect(scoreBoardPoint(at(60, 279 - 0.05)).segment).toBe(11);
    expect(scoreBoardPoint(at(60, 279 + 0.05)).segment).toBe(14);

    expect(scoreBoardPoint(at(60, 351 - 0.05)).segment).toBe(5);
    expect(scoreBoardPoint(at(60, 351 + 0.05)).segment).toBe(20);
  });

  it('does not depend on the sign or range of the input angle', () => {
    // Deliberately uses the CENTRE of the 20 wedge, not a wire angle: an angle
    // that normalises onto a boundary is decided by whatever the sin/cos round
    // trip rounds to, so asserting an outcome there would be asserting float
    // noise rather than behaviour.
    expect(scoreBoardPoint(at(60, 0)).segment).toBe(20);
    expect(scoreBoardPoint(at(60, 360)).segment).toBe(20);
    expect(scoreBoardPoint(at(60, -360)).segment).toBe(20);
    expect(scoreBoardPoint(at(60, 720)).segment).toBe(20);
    expect(scoreBoardPoint(at(60, 1080)).segment).toBe(20);
    expect(scoreBoardPoint(at(60, -720)).segment).toBe(20);
  });
});

describe('scoring table sanity', () => {
  it('never scores a single above 20, a double above 40 or a treble above 60', () => {
    for (let angle = 0; angle < 360; angle += 1.3) {
      for (let radiusMm = 0; radiusMm <= 175; radiusMm += 1.7) {
        const score = scoreBoardPoint(at(radiusMm, angle));
        if (score.multiplier === 1 && score.ring !== 'inner-bull') expect(score.score).toBeLessThanOrEqual(25);
        if (score.multiplier === 2) expect(score.score).toBeLessThanOrEqual(40);
        if (score.multiplier === 3) expect(score.score).toBeLessThanOrEqual(60);
      }
    }
  });

  it('sums a three dart visit', () => {
    const darts = [at(103, 0), at(166, 0), at(10)].map(scoreBoardPoint);
    expect(darts.map((d) => d.label)).toEqual(['T20', 'D20', '25']);
    expect(sumScores(darts)).toBe(60 + 40 + 25);
  });

  it('reports the polar form used internally for a treble 20', () => {
    const polar = boardPointToPolar(at(103, 0));
    expect(polar.radius).toBeCloseTo(103 / 170, 12);
    expect(polar.angleFromTopClockwiseDeg).toBeCloseTo(0, 12);
  });
});
