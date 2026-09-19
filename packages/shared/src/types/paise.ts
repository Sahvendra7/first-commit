import { z } from 'zod';

/**
 * Money — architecture.md §6.4: "Money is stored in paise as integers. Never
 * floats, anywhere." CLAUDE.md repeats it as a hard constraint.
 *
 * `Paise` is a branded integer. The brand is erased at runtime (it is still a
 * `number` on the wire and in DynamoDB) but it makes it a type error to pass a
 * raw `number`, a rupee amount, or the result of a float multiplication into
 * anything that expects money. Every route into the type runs the same runtime
 * guard, so the type-level promise and the runtime check cannot drift.
 */
declare const PaiseBrand: unique symbol;
export type Paise = number & { readonly [PaiseBrand]: 'Paise' };

/** Thrown by the guarded constructors. Carries the rejected value for logs. */
export class InvalidPaiseError extends Error {
  readonly value: unknown;
  constructor(value: unknown, reason: string) {
    super(`Invalid paise value (${reason}): ${String(value)}`);
    this.name = 'InvalidPaiseError';
    this.value = value;
  }
}

/**
 * Upper bound. Paise are stored as DynamoDB numbers and round-tripped through
 * JSON, so they must stay inside the IEEE-754 safe-integer range. This bound is
 * ~₹90,071,992,547 — far beyond any plausible deposit, and the point is to fail
 * loudly rather than silently lose a digit.
 */
export const MAX_PAISE = Number.MAX_SAFE_INTEGER;

/**
 * Runtime predicate. A valid `Paise` is a non-negative, finite, safe integer.
 *
 * Negatives are rejected because every money field in this system — deposit,
 * claimed deductions, amount received, shortfall, interest — is a magnitude.
 * Direction is expressed by which field a value lands in, never by its sign, so
 * a negative here always means a bug upstream rather than a refund.
 */
export function isPaise(value: unknown): value is Paise {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_PAISE &&
    !Object.is(value, -0)
  );
}

/**
 * Guarded constructor: an integer number of paise in, a branded `Paise` out.
 * Throws `InvalidPaiseError` on floats, negatives, NaN, Infinity, non-numbers
 * and values past the safe-integer bound.
 *
 * This is the only sanctioned way to mint a `Paise` from an untrusted number.
 */
export function toPaise(value: unknown): Paise {
  if (typeof value !== 'number') throw new InvalidPaiseError(value, 'not a number');
  if (!Number.isFinite(value)) throw new InvalidPaiseError(value, 'not finite');
  if (!Number.isInteger(value)) throw new InvalidPaiseError(value, 'not an integer');
  if (Object.is(value, -0)) throw new InvalidPaiseError(value, 'negative zero');
  if (value < 0) throw new InvalidPaiseError(value, 'negative');
  if (value > MAX_PAISE) throw new InvalidPaiseError(value, 'exceeds MAX_PAISE');
  return value as Paise;
}

/** Non-throwing variant, for validating user input without exceptions. */
export function tryToPaise(value: unknown): Paise | undefined {
  return isPaise(value) ? value : undefined;
}

/**
 * Convert a rupee amount to `Paise` without ever touching a float.
 *
 * Accepts a string (`"1234.50"`, the form an input field produces) or an
 * integer number of whole rupees. A non-integer `number` of rupees is rejected
 * on purpose: `1.15 * 100` is `114.99999999999999`, and that rounding is
 * exactly the class of bug §6.4 forbids. Pass rupees as a string and the
 * fractional part is parsed digit-wise instead.
 */
export function rupeesToPaise(rupees: string | number): Paise {
  if (typeof rupees === 'number') {
    if (!Number.isInteger(rupees)) {
      throw new InvalidPaiseError(
        rupees,
        'fractional rupees must be passed as a string to avoid float error',
      );
    }
    return toPaise(rupees * 100);
  }
  const trimmed = rupees.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) throw new InvalidPaiseError(rupees, 'not a rupee amount');
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(whole)) throw new InvalidPaiseError(rupees, 'rupees out of range');
  return toPaise(whole * 100 + fraction);
}

/** Split paise into whole rupees and the 0–99 paise remainder. */
export function splitRupees(value: Paise): { rupees: number; paise: number } {
  return { rupees: Math.trunc(value / 100), paise: value % 100 };
}

/**
 * Format for display and for PDF/letter text.
 *
 * Indian digit grouping (last three, then pairs: `₹12,34,567.89`) is
 * hand-rolled rather than delegated to `Intl.NumberFormat`. Two reasons: this
 * package must stay dependency-free and identical in a browser and in a Lambda,
 * and the output goes into a legal document, where the grouping must not vary
 * with the host's ICU build.
 */
export function formatRupees(
  value: Paise,
  options: { symbol?: boolean; paise?: boolean } = {},
): string {
  const { symbol = true, paise: showPaise = true } = options;
  const { rupees, paise } = splitRupees(value);
  const digits = String(rupees);
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const lastThree = digits.slice(-3);
    const rest = digits.slice(0, -3);
    grouped = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}`;
  }
  const body = showPaise ? `${grouped}.${String(paise).padStart(2, '0')}` : grouped;
  return symbol ? `₹${body}` : body;
}

/**
 * Zod schema for a paise field. Used by every request/response schema so the
 * wire contract enforces the same rule the type does, on both sides of the API.
 */
export const paiseSchema: z.ZodType<Paise, z.ZodTypeDef, number> = z
  .number({ invalid_type_error: 'must be an integer number of paise' })
  .int('must be an integer number of paise — never a float (§6.4)')
  .nonnegative('must not be negative')
  .max(MAX_PAISE, 'exceeds the safe-integer bound')
  .refine((n) => !Object.is(n, -0), 'must not be negative zero')
  .transform((n) => n as Paise);

/** `paiseSchema` with a `> 0` floor — e.g. `depositPaise` (§7, INVALID_DEPOSIT). */
export const positivePaiseSchema: z.ZodType<Paise, z.ZodTypeDef, number> = z
  .number({ invalid_type_error: 'must be an integer number of paise' })
  .int('must be an integer number of paise — never a float (§6.4)')
  .positive('must be greater than zero')
  .max(MAX_PAISE, 'exceeds the safe-integer bound')
  .transform((n) => n as Paise);
