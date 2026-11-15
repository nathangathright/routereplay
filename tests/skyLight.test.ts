import { describe, expect, it } from 'vitest';
import { AIR_GLSL } from '../src/app/render/lighting';
import { SKY_AIR, SKY_COLUMNS, SKY_DIRECTIONS, SKY_MU0, skyTable } from '../src/app/render/skyLight';

const DECK = 1.004;
const table = skyTable([DECK, 1.0085]);
/** RGB at layer, row (0 zenith, 1 toward the Sun, 2 away), column. */
const at = (layer: number, row: number, column: number) => {
  const o = ((layer * SKY_DIRECTIONS + row) * SKY_COLUMNS + column) * 4;
  return [table[o]!, table[o + 1]!, table[o + 2]!];
};
const column = (elevationDeg: number) => Math.round(((Math.sin((elevationDeg * Math.PI) / 180) - SKY_MU0) / (1 - SKY_MU0)) * (SKY_COLUMNS - 1));
const luminance = ([r, g, b]: number[]) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;

describe('sky light on clouds', () => {
  it('uses the atmosphere’s own constants', () => {
    expect(AIR_GLSL).toContain(`const float TOP = ${SKY_AIR.TOP.toFixed(4)};`);
    expect(AIR_GLSL).toContain(`const float H_R = ${SKY_AIR.H_R.toFixed(7)};`);
    expect(AIR_GLSL).toContain(`const float H_M = ${SKY_AIR.H_M.toFixed(7)};`);
    expect(AIR_GLSL).toContain(`const vec3 BETA_R = vec3(0.0058, 0.0135, 0.0331) * ${(6371.0 / 7.2).toFixed(4)};`);
    expect(AIR_GLSL).toContain(`const float BETA_M = 0.0030 * ${(6371.0 / 7.2).toFixed(4)};`);
    expect(SKY_AIR.BETA_R[2]).toBeCloseTo((0.0331 * 6371) / 7.2, 9);
    expect(SKY_AIR.BETA_M).toBeCloseTo((0.003 * 6371) / 7.2, 9);
  });

  it('is finite, never negative, and the same every time it is built', () => {
    expect(table.every((x) => Number.isFinite(x) && x >= 0)).toBe(true);
    expect(skyTable([DECK, 1.0085])).toEqual(table);
  });

  it('is blue overhead by day, and brighter toward a low Sun than away from it', () => {
    const noon = at(0, 0, column(60));
    expect(noon[2]!).toBeGreaterThan(2 * noon[0]!);
    const toward = at(0, 1, column(10));
    const away = at(0, 2, column(10));
    expect(luminance(toward)).toBeGreaterThan(luminance(away));
  });

  it('stays lit, and blue, a few degrees after sunset, and is gone in full night', () => {
    const sunset = luminance(at(0, 0, column(0)));
    const after = at(0, 0, column(-4));
    expect(luminance(after)).toBeGreaterThan(0.5 * sunset);
    expect(after[2]!).toBeGreaterThan(after[0]!);
    expect(luminance(at(0, 0, 0))).toBeLessThan(0.01 * luminance(at(0, 0, column(60))));
  });

  it('is darker above a higher layer, which has less air over it', () => {
    expect(luminance(at(1, 0, column(45)))).toBeLessThan(luminance(at(0, 0, column(45))));
  });

  // Twilight fades by about a quarter per column near −6°; linear interpolation between columns is within 1 % there.
  it('changes smoothly from one column to the next near the horizon', () => {
    for (let c = column(-6); c < column(10); c++) {
      for (let row = 0; row < SKY_DIRECTIONS; row++) {
        const a = luminance(at(0, row, c));
        const b = luminance(at(0, row, c + 1));
        expect(Math.abs(b - a) / Math.max(a, b), `row ${row}, column ${c}: ${a} → ${b}`).toBeLessThan(0.3);
      }
    }
  });
});
