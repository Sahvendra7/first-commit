/**
 * `JourneyStages` — the indicator must follow the record, not the navigation.
 *
 * A freshly created tenancy is `MOVEIN_PENDING` (§7), and showing it anywhere
 * but Move-in would be the same class of error as the phase bug fixed in
 * f6f83c2: the screen asserting a stage the stored status does not support.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TenancyStatus } from '@handover/shared';
import { JourneyStages } from './JourneyStages.js';

afterEach(cleanup);

/** The stage each status must highlight. */
const EXPECTED: ReadonlyArray<readonly [TenancyStatus, string]> = [
  ['MOVEIN_PENDING', 'Move-in'],
  ['MOVEIN_COMPLETE', 'Condition'],
  ['MOVEOUT_PENDING', 'Condition'],
  ['MOVEOUT_COMPLETE', 'Move-out'],
  ['AWAITING_REFUND', 'Recovery'],
  ['OVERDUE', 'Recovery'],
];

describe('JourneyStages', () => {
  it('renders all four stages', () => {
    render(<JourneyStages status="MOVEIN_PENDING" />);
    for (const label of ['Move-in', 'Condition', 'Move-out', 'Recovery']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it.each(EXPECTED)('marks %s as the %s stage', (status, label) => {
    render(<JourneyStages status={status} />);
    const current = screen.getByText(label).closest('[aria-current="step"]');
    expect(current).not.toBeNull();
  });

  it('marks exactly one stage as current', () => {
    const { container } = render(<JourneyStages status="MOVEOUT_PENDING" />);
    expect(container.querySelectorAll('[aria-current="step"]').length).toBe(1);
  });

  it('never shows a new tenancy past move-in', () => {
    render(<JourneyStages status="MOVEIN_PENDING" />);
    const moveOut = screen.getByText('Move-out').closest('[aria-current="step"]');
    expect(moveOut).toBeNull();
  });
});
