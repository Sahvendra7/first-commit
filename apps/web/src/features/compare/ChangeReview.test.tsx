/**
 * Accept/reject on the room's own screen — §7 PATCH, §9.7.
 *
 * These assertions were written against `ConditionSummary`, where the controls
 * used to be rendered (on the room cards). The controls moved to `ChangeReview`
 * on the room detail screen; the *rules* did not move, so the tests came with
 * them rather than being rewritten.
 *
 * §9.7's rule is the one they defend: "the tenant must affirmatively accept
 * each change". A suggestion that reaches a PDF without a press here is the
 * single worst bug this product can have, so the controls are asserted to
 * exist, to report the current disposition to assistive technology, and to send
 * exactly the change the tenant pressed — with the room it belongs to.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DiffChange, RoomDiffView } from '@handover/shared';
import { ChangeReview, REVIEW_REASON_COPY } from './ChangeReview.js';

afterEach(cleanup);

function change(over: Partial<DiffChange> = {}): DiffChange {
  return {
    id: 'chg_1',
    type: 'STAIN',
    surface: 'WALL',
    location: 'wall left of the window',
    description: 'A dark mark about the size of a hand.',
    confidence: 0.62,
    source: 'MODEL',
    ...over,
  } as DiffChange;
}

function room(changes: DiffChange[], over: Partial<RoomDiffView> = {}): RoomDiffView {
  return {
    roomId: 'room_1',
    roomLabel: 'Living room',
    status: 'COMPLETE',
    changes,
    before: [],
    after: [],
    ...over,
  } as RoomDiffView;
}

function renderReview(target: RoomDiffView, props: Record<string, unknown> = {}) {
  return render(<ChangeReview room={target} {...props} />);
}

describe('ChangeReview — recording a decision', () => {
  it('offers no decision controls when the screen is read-only', () => {
    renderReview(room([change()]));
    expect(screen.queryByTestId('accept-chg_1')).toBeNull();
    expect(screen.queryByTestId('reject-chg_1')).toBeNull();
  });

  it('sends ACCEPT for the change the tenant accepted, with its room', () => {
    const onDecideChange = vi.fn();
    renderReview(room([change()]), { onDecideChange });

    fireEvent.click(screen.getByTestId('accept-chg_1'));

    expect(onDecideChange).toHaveBeenCalledTimes(1);
    expect(onDecideChange).toHaveBeenCalledWith('room_1', 'chg_1', 'ACCEPT');
  });

  it('sends REJECT for the change the tenant rejected', () => {
    const onDecideChange = vi.fn();
    renderReview(room([change()]), { onDecideChange });

    fireEvent.click(screen.getByTestId('reject-chg_1'));

    expect(onDecideChange).toHaveBeenCalledWith('room_1', 'chg_1', 'REJECT');
  });

  it('reports the current disposition through aria-pressed, not by disabling', () => {
    renderReview(room([change({ tenantAction: 'ACCEPT' })]), { onDecideChange: vi.fn() });

    const accept = screen.getByTestId('accept-chg_1');
    const reject = screen.getByTestId('reject-chg_1');

    expect(accept.getAttribute('aria-pressed')).toBe('true');
    expect(reject.getAttribute('aria-pressed')).toBe('false');
    // Still reachable: a tenant who changes their mind must be able to say so.
    expect((accept as HTMLButtonElement).disabled).toBe(false);
    expect((reject as HTMLButtonElement).disabled).toBe(false);
  });

  it('lets a tenant reverse a decision they already made', () => {
    const onDecideChange = vi.fn();
    renderReview(room([change({ tenantAction: 'ACCEPT' })]), { onDecideChange });

    fireEvent.click(screen.getByTestId('reject-chg_1'));
    expect(onDecideChange).toHaveBeenCalledWith('room_1', 'chg_1', 'REJECT');
  });

  it('disables both controls while a decision is in flight', () => {
    renderReview(room([change()]), { onDecideChange: vi.fn(), deciding: true });

    expect((screen.getByTestId('accept-chg_1') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('reject-chg_1') as HTMLButtonElement).disabled).toBe(true);
  });

  it('routes a decision to the room it is rendered for', () => {
    const onDecideChange = vi.fn();
    renderReview(
      room([change({ id: 'chg_b' })], { roomId: 'room_b', roomLabel: 'Bathroom' }),
      { onDecideChange },
    );

    fireEvent.click(screen.getByTestId('accept-chg_b'));
    expect(onDecideChange).toHaveBeenCalledWith('room_b', 'chg_b', 'ACCEPT');
  });

  it('offers the same controls for a tenant-authored change, so it can be withdrawn', () => {
    const onDecideChange = vi.fn();
    renderReview(
      room([change({ id: 'chg_t', source: 'TENANT', confidence: 1, tenantAction: 'ACCEPT' })]),
      { onDecideChange },
    );

    fireEvent.click(screen.getByTestId('reject-chg_t'));
    expect(onDecideChange).toHaveBeenCalledWith('room_1', 'chg_t', 'REJECT');
  });
});

describe('ChangeReview — how a decision is shown', () => {
  it('shows an undecided change as pending, and says nothing is included yet', () => {
    renderReview(room([change()]), { onDecideChange: vi.fn() });

    expect(screen.getByTestId('status-chg_1').textContent).toContain('Pending');
    expect(screen.getByTestId('decision-chg_1').textContent).toMatch(
      /no decision recorded yet/i,
    );
  });

  it('states the recorded decision once a change is accepted', () => {
    renderReview(room([change({ tenantAction: 'ACCEPT' })]), { onDecideChange: vi.fn() });

    expect(screen.getByTestId('status-chg_1').textContent).toContain('Accepted');
    expect(screen.getByTestId('decision-chg_1').textContent).toMatch(
      /recorded decision — accepted/i,
    );
  });

  it('states the recorded decision once a change is rejected', () => {
    renderReview(room([change({ tenantAction: 'REJECT' })]), { onDecideChange: vi.fn() });

    expect(screen.getByTestId('status-chg_1').textContent).toContain('Rejected');
    expect(screen.getByTestId('decision-chg_1').textContent).toMatch(
      /stays out of your record/i,
    );
  });

  it('counts only undecided model suggestions in the "to decide" badge', () => {
    renderReview(
      room([
        change({ id: 'chg_a' }),
        change({ id: 'chg_b' }),
        change({ id: 'chg_c', tenantAction: 'ACCEPT' }),
        change({ id: 'chg_d', source: 'TENANT', confidence: 1, tenantAction: 'ACCEPT' }),
      ]),
      { onDecideChange: vi.fn() },
    );

    expect(screen.getByTestId('undecided-room_1').textContent).toContain('2 to decide');
  });

  it('drops the "to decide" badge once every suggestion has an answer', () => {
    renderReview(room([change({ tenantAction: 'REJECT' })]), { onDecideChange: vi.fn() });
    expect(screen.queryByTestId('undecided-room_1')).toBeNull();
  });
});

describe('ChangeReview — what may and may not be asserted', () => {
  it('never labels a tenant-authored change as a model suggestion', () => {
    renderReview(
      room([change({ id: 'chg_t', source: 'TENANT', confidence: 1, tenantAction: 'ACCEPT' })]),
      { onDecideChange: vi.fn() },
    );

    // `confidence: 1` on a TENANT change is a compatibility value, not a score.
    // It must never be drawn as one.
    expect(screen.queryByTestId('suggestion-label-chg_t')).toBeNull();
    expect(screen.queryByTestId('confidence-chg_t')).toBeNull();
    expect(screen.queryByText(/model confidence/i)).toBeNull();
  });

  it('marks a tenant-authored change as the tenant’s own', () => {
    renderReview(
      room([change({ id: 'chg_t', source: 'TENANT', confidence: 1 })]),
      { onDecideChange: vi.fn() },
    );

    expect(screen.getByTestId('change-chg_t').textContent).toContain('Added by you');
  });

  it('marks a model change as a possibility, never as a finding', () => {
    renderReview(room([change()]), { onDecideChange: vi.fn() });

    expect(screen.getByTestId('suggestion-label-chg_1').textContent).toContain(
      'Possible change',
    );
    // No verdict language anywhere on the entry.
    const text = screen.getByTestId('change-chg_1').textContent ?? '';
    expect(text).not.toMatch(/damage|wear and tear is|normal wear/i);
  });

  it('shows model confidence only as decoration beside a suggestion', () => {
    renderReview(room([change({ confidence: 0.62 })]), { onDecideChange: vi.fn() });

    expect(screen.getByTestId('confidence-chg_1').textContent).toContain(
      'model confidence 0.62',
    );
  });

  it('never aggregates confidence — it is a label, not arithmetic', () => {
    const { container } = renderReview(
      room([change({ id: 'chg_a', confidence: 0.82 }), change({ id: 'chg_b', confidence: 0.4 })]),
      { onDecideChange: vi.fn() },
    );

    // Each figure appears beside its own change; no mean, sum or percentage of
    // them appears anywhere.
    expect(container.textContent).toContain('0.82');
    expect(container.textContent).toContain('0.40');
    expect(container.textContent).not.toMatch(/61%|0\.61|average confidence/i);
  });

  it('styles a model suggestion differently from a change the tenant wrote', () => {
    renderReview(
      room([
        change({ id: 'chg_m' }),
        change({ id: 'chg_t', source: 'TENANT', confidence: 1 }),
      ]),
      { onDecideChange: vi.fn() },
    );

    expect(screen.getByTestId('change-chg_m').className).toContain('brand');
    expect(screen.getByTestId('change-chg_t').className).not.toContain('brand');
  });

  it('renders both sides of the wear-and-tear argument, or neither', () => {
    renderReview(
      room([
        change({
          wearAndTear: {
            landlordMayArgue: 'The mark is beyond ordinary use.',
            tenantsTypicallyCounter: 'Six years of occupancy is ordinary use.',
          },
        }),
      ]),
      { onDecideChange: vi.fn() },
    );

    const wear = screen.getByTestId('wear-chg_1');
    expect(wear.textContent).toContain('A landlord may argue:');
    expect(wear.textContent).toContain('Tenants typically counter:');
  });

  it('shows no wear-and-tear block when the change carries no argument', () => {
    renderReview(room([change()]), { onDecideChange: vi.fn() });
    expect(screen.queryByTestId('wear-chg_1')).toBeNull();
  });
});

describe('ChangeReview — a room with nothing on it', () => {
  it('treats AI_DISABLED as the ordinary manual path, not an error', () => {
    renderReview(room([], { status: 'NEEDS_REVIEW', reviewReason: 'AI_DISABLED' }), {
      reason: REVIEW_REASON_COPY.AI_DISABLED,
      onDecideChange: vi.fn(),
    });

    expect(screen.getByTestId('review-empty-room_1').textContent).toMatch(
      /add anything you can see/i,
    );
  });

  it('explains a real anomaly without implying the evidence is at risk', () => {
    renderReview(room([], { status: 'NEEDS_REVIEW', reviewReason: 'MODEL_ERROR' }), {
      reason: REVIEW_REASON_COPY.MODEL_ERROR,
      onDecideChange: vi.fn(),
    });

    const empty = screen.getByTestId('review-empty-room_1').textContent ?? '';
    expect(empty).toMatch(/did not run/i);
    expect(empty).toMatch(/timestamps are unaffected/i);
  });

  it('writes distinct copy per review reason', () => {
    const { unmount } = renderReview(
      room([], { status: 'NEEDS_REVIEW', reviewReason: 'MISSING_PAIR' }),
      { reason: REVIEW_REASON_COPY.MISSING_PAIR },
    );
    expect(screen.getByTestId('review-empty-room_1').textContent).toContain(
      'no matching pair of photographs',
    );
    unmount();

    renderReview(room([], { status: 'NEEDS_REVIEW', reviewReason: 'LOW_CONFIDENCE' }), {
      reason: REVIEW_REASON_COPY.LOW_CONFIDENCE,
    });
    expect(screen.getByTestId('review-empty-room_1').textContent).toContain('was unclear');
  });

  it('offers no decision controls when there is nothing to decide', () => {
    renderReview(room([]), { onDecideChange: vi.fn() });
    expect(screen.queryByTestId('review-list-room_1')).toBeNull();
  });
});
