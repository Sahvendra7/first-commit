import { describe, expect, it } from 'vitest';
import {
  InvalidPaiseError,
  MAX_PAISE,
  formatRupees,
  isPaise,
  paiseSchema,
  positivePaiseSchema,
  rupeesToPaise,
  splitRupees,
  toPaise,
  tryToPaise,
} from '../src/types/paise.js';

/**
 * architecture.md §6.4: money is integer paise, never a float. CLAUDE.md:
 * "A wrong number in a legal letter is a catastrophic failure, not a bug."
 * These tests are the enforcement of that sentence.
 */

describe('toPaise', () => {
  it('accepts non-negative safe integers', () => {
    expect(toPaise(0)).toBe(0);
    expect(toPaise(1)).toBe(1);
    expect(toPaise(5_000_00)).toBe(500000);
    expect(toPaise(MAX_PAISE)).toBe(MAX_PAISE);
  });

  it.each([0.1, 1.5, 1234.56, 99.999, 1e-7])('rejects the float %p', (v) => {
    expect(() => toPaise(v)).toThrow(InvalidPaiseError);
    expect(() => toPaise(v)).toThrow(/not an integer/);
  });

  it('rejects a float that looks integral only after formatting', () => {
    // The canonical bug: 1.15 rupees * 100 is 114.99999999999999, not 115.
    expect(1.15 * 100).not.toBe(115);
    expect(() => toPaise(1.15 * 100)).toThrow(/not an integer/);
    expect(1.1 * 100).not.toBe(110);
    expect(() => toPaise(1.1 * 100)).toThrow(/not an integer/);
    // ...and the same amount routed through rupeesToPaise is exact.
    expect(rupeesToPaise('1.15')).toBe(115);
    expect(rupeesToPaise('1.10')).toBe(110);
  });

  it.each([-1, -100, -0.5, Number.MIN_SAFE_INTEGER])('rejects the negative %p', (v) => {
    expect(() => toPaise(v)).toThrow(InvalidPaiseError);
  });

  it('rejects negative zero', () => {
    expect(() => toPaise(-0)).toThrow(/negative zero/);
  });

  it.each([NaN, Infinity, -Infinity])('rejects %p', (v) => {
    expect(() => toPaise(v)).toThrow(/not finite/);
  });

  it.each([Number.MAX_SAFE_INTEGER + 2, 1e300])('rejects out-of-range %p', (v) => {
    expect(() => toPaise(v)).toThrow(/exceeds MAX_PAISE/);
  });

  it.each([['1000'], [null], [undefined], [{}], [[]], [true], [10n]])(
    'rejects the non-number %p',
    (v) => {
      expect(() => toPaise(v)).toThrow(/not a number/);
    },
  );

  it('carries the rejected value on the error for logging', () => {
    try {
      toPaise(1.5);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidPaiseError);
      expect((err as InvalidPaiseError).value).toBe(1.5);
    }
  });
});

describe('isPaise / tryToPaise', () => {
  it('agrees with toPaise on what is valid', () => {
    for (const v of [0, 1, 999, MAX_PAISE]) expect(isPaise(v)).toBe(true);
    for (const v of [-1, 1.5, NaN, Infinity, '1', null, -0]) expect(isPaise(v)).toBe(false);
  });

  it('tryToPaise returns undefined instead of throwing', () => {
    expect(tryToPaise(250)).toBe(250);
    expect(tryToPaise(2.5)).toBeUndefined();
    expect(tryToPaise(-250)).toBeUndefined();
  });
});

describe('rupeesToPaise', () => {
  it('converts whole-rupee numbers', () => {
    expect(rupeesToPaise(0)).toBe(0);
    expect(rupeesToPaise(1)).toBe(100);
    expect(rupeesToPaise(50_000)).toBe(5_000_000);
  });

  it('converts decimal rupee strings without float error', () => {
    expect(rupeesToPaise('12.34')).toBe(1234);
    expect(rupeesToPaise('0.01')).toBe(1);
    expect(rupeesToPaise('0.1')).toBe(10);
    expect(rupeesToPaise('1234.5')).toBe(123450);
    expect(rupeesToPaise('50000')).toBe(5_000_000);
    expect(rupeesToPaise(' 99.99 ')).toBe(9999);
  });

  it('rejects fractional rupees passed as a number', () => {
    expect(() => rupeesToPaise(12.34)).toThrow(/must be passed as a string/);
  });

  it.each(['12.345', '-5', '1,234', 'abc', '', '.5', '12.'])('rejects %p', (v) => {
    expect(() => rupeesToPaise(v)).toThrow(InvalidPaiseError);
  });
});

describe('formatRupees', () => {
  it('uses Indian digit grouping', () => {
    expect(formatRupees(toPaise(0))).toBe('₹0.00');
    expect(formatRupees(toPaise(1))).toBe('₹0.01');
    expect(formatRupees(toPaise(99))).toBe('₹0.99');
    expect(formatRupees(toPaise(100))).toBe('₹1.00');
    expect(formatRupees(toPaise(123456))).toBe('₹1,234.56');
    expect(formatRupees(toPaise(100000))).toBe('₹1,000.00');
    expect(formatRupees(toPaise(1000000))).toBe('₹10,000.00');
    expect(formatRupees(toPaise(10000000))).toBe('₹1,00,000.00');
    expect(formatRupees(toPaise(123456789))).toBe('₹12,34,567.89');
    expect(formatRupees(toPaise(1234567890))).toBe('₹1,23,45,678.90');
  });

  it('honours the symbol and paise options', () => {
    expect(formatRupees(toPaise(123456), { symbol: false })).toBe('1,234.56');
    expect(formatRupees(toPaise(123400), { paise: false })).toBe('₹1,234');
    expect(formatRupees(toPaise(123456), { symbol: false, paise: false })).toBe('1,234');
  });

  it('does not vary with the host ICU build', () => {
    // Hand-rolled on purpose (§6.4 — the number goes into a legal letter).
    expect(formatRupees(toPaise(50_00_000))).toBe('₹50,000.00');
  });
});

describe('splitRupees', () => {
  it('splits into whole rupees and a 0-99 remainder', () => {
    expect(splitRupees(toPaise(123456))).toEqual({ rupees: 1234, paise: 56 });
    expect(splitRupees(toPaise(0))).toEqual({ rupees: 0, paise: 0 });
    expect(splitRupees(toPaise(7))).toEqual({ rupees: 0, paise: 7 });
  });
});

describe('paiseSchema', () => {
  it('parses valid integers', () => {
    expect(paiseSchema.parse(0)).toBe(0);
    expect(paiseSchema.parse(5000)).toBe(5000);
  });

  it.each([1.5, -1, NaN, '100', null])('rejects %p at the wire boundary', (v) => {
    expect(paiseSchema.safeParse(v).success).toBe(false);
  });

  it('reports the float rejection with a message that names the rule', () => {
    const result = paiseSchema.safeParse(1234.56);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/never a float/);
    }
  });

  it('positivePaiseSchema rejects zero — depositPaise > 0 (§7)', () => {
    expect(positivePaiseSchema.safeParse(0).success).toBe(false);
    expect(positivePaiseSchema.safeParse(1).success).toBe(true);
  });
});
