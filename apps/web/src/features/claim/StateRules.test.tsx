/**
 * `StateRules` — the tests here are all about refusing to state a legal fact
 * the data does not carry.
 *
 * `data/state-rules/KA.json` is `DRAFT_PENDING_LEGAL_REVIEW` and says twice, in
 * its own notes, that a zero is an absence: `depositCapMonths: 0` "must not be
 * displayed as 'the cap is zero'", and `statutoryInterestBps: 0` encodes "no
 * statutory interest rate asserted". ADR 0001 adds the third rule: an absent
 * `lastReviewedAt` is never backfilled with a date.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { GetStateRulesResponse } from '@handover/shared';
import { StateRules } from './StateRules.js';

afterEach(cleanup);

/** Mirrors the shipped KA seed, including its zeros and its missing date. */
const KA: GetStateRulesResponse = {
  stateCode: 'KA',
  stateName: 'Karnataka',
  mtaAdopted: false,
  depositCapMonths: 0,
  refundWindowDays: 30,
  statutoryInterestBps: 0,
  authorityName: 'Court of Small Causes, Bengaluru',
  escalationSteps: [
    {
      order: 0,
      label: 'Written demand to the landlord',
      description: 'Send a dated, itemised demand for the deposit.',
      afterDays: 0,
    },
    {
      order: 1,
      label: 'Legal notice',
      description: 'Instruct a lawyer to send a notice.',
      afterDays: 15,
    },
  ],
  statuteRefs: [
    {
      citation: 'Karnataka Rent Act, 1999',
      title: 'The operative rent legislation for Karnataka',
      url: 'https://dpal.karnataka.gov.in/',
    },
  ],
} as GetStateRulesResponse;

function renderRules(over: Partial<GetStateRulesResponse> = {}) {
  return render(<StateRules rules={{ ...KA, ...over } as GetStateRulesResponse} />);
}

describe('StateRules — the review date (R9, ADR 0001)', () => {
  it('shows a draft notice when lastReviewedAt is absent', () => {
    renderRules();

    expect(screen.getByTestId('rules-unreviewed').textContent).toMatch(
      /draft — pending legal review/i,
    );
    expect(screen.queryByTestId('rules-reviewed')).toBeNull();
  });

  it('never invents a review date when the field is absent', () => {
    renderRules();

    const today = new Date().toISOString().slice(0, 10);
    expect(screen.getByTestId('state-rules').textContent).not.toContain(today);
    expect(screen.getByTestId('state-rules').textContent).not.toMatch(/reviewed \d{4}-/i);
  });

  it('shows the review date when the data carries one', () => {
    renderRules({ lastReviewedAt: '2026-01-15' } as Partial<GetStateRulesResponse>);

    expect(screen.getByTestId('rules-reviewed').textContent).toContain('2026-01-15');
    expect(screen.queryByTestId('rules-unreviewed')).toBeNull();
  });
});

describe('StateRules — a zero is an absence, not a value', () => {
  it('does not render a zero deposit cap as "0 months"', () => {
    renderRules();

    const cap = screen.getByTestId('deposit-cap');
    expect(cap.textContent).toBe('No statutory cap asserted');
    expect(cap.textContent).not.toMatch(/\b0\b/);
  });

  it('does not render a zero statutory interest rate as "0%"', () => {
    renderRules();

    const interest = screen.getByTestId('statutory-interest');
    expect(interest.textContent).toBe('No statutory rate asserted');
    expect(interest.textContent).not.toContain('0%');
  });

  it('renders a real deposit cap when one is asserted', () => {
    renderRules({ depositCapMonths: 2 });
    expect(screen.getByTestId('deposit-cap').textContent).toContain("2 months' rent");
  });

  it('converts basis points to a percentage for display only', () => {
    renderRules({ statutoryInterestBps: 600 });
    expect(screen.getByTestId('statutory-interest').textContent).toBe('6% a year');
  });

  it('keeps two decimal places for a fractional rate', () => {
    renderRules({ statutoryInterestBps: 650 });
    expect(screen.getByTestId('statutory-interest').textContent).toBe('6.50% a year');
  });

  it('does not render a zero refund window as "0 days"', () => {
    renderRules({ refundWindowDays: 0 });
    expect(screen.getByTestId('refund-window').textContent).toBe(
      'No statutory window asserted',
    );
  });
});

describe('StateRules — reference content', () => {
  it('shows the refund window the data asserts', () => {
    renderRules();
    expect(screen.getByTestId('refund-window').textContent).toBe('30 days');
  });

  it('names the forum from the data, never from a model', () => {
    renderRules();
    expect(screen.getByTestId('authority').textContent).toBe(
      'Court of Small Causes, Bengaluru',
    );
  });

  it('orders escalation steps by their order field, not their array position', () => {
    renderRules({
      escalationSteps: [
        { order: 2, label: 'Third', description: 'c' },
        { order: 0, label: 'First', description: 'a' },
        { order: 1, label: 'Second', description: 'b' },
      ],
    });

    const labels = Array.from(
      screen.getByTestId('escalation-steps').querySelectorAll('li'),
    ).map((li) => li.textContent ?? '');

    expect(labels[0]).toContain('First');
    expect(labels[1]).toContain('Second');
    expect(labels[2]).toContain('Third');
  });

  it('treats afterDays 0 as "straight away" rather than printing "after 0 days"', () => {
    renderRules();
    expect(screen.getByTestId('escalation-0').textContent).not.toContain('after 0 days');
  });

  it('shows a real waiting period when one is set', () => {
    renderRules();
    expect(screen.getByTestId('escalation-1').textContent).toContain('after 15 days');
  });

  it('links statute references safely', () => {
    renderRules();
    const link = screen.getByTestId('statute-refs').querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://dpal.karnataka.gov.in/');
    expect(link?.getAttribute('rel')).toContain('noopener');
  });

  it('states plainly that this is not legal advice', () => {
    renderRules();
    expect(screen.getByTestId('state-rules').textContent).toMatch(/not legal advice/i);
  });

  it('never claims legal admissibility or a guaranteed outcome', () => {
    renderRules();
    const text = screen.getByTestId('state-rules').textContent ?? '';
    expect(text).not.toMatch(/admissible|court[- ]proof|guarantee/i);
  });
});
