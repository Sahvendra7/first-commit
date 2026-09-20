/**
 * Accept/reject on the condition summary — §7 PATCH, §9.7.
 *
 * §9.7's rule is the one these tests defend: "the tenant must affirmatively
 * accept each change". A suggestion that reaches a PDF without a press here is
 * the single worst bug this screen can have, so the controls are asserted to
 * exist, to report the current disposition to assistive technology, and to send
 * exactly the change the tenant pressed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DiffChange, RoomDiffView, TenancySummary } from '@handover/shared';
import { ConditionSummary } from './ConditionSummary.js';

afterEach(cleanup);

const tenancy: TenancySummary = {
  tenancyId: 'ten_1',
  status: 'MOVEOUT_COMPLETE',
  addressLine: '12 Residency Road',
  city: 'Bengaluru',
  stateCode: 'KA',
  monthlyRentPaise: 4_500_000,
  depositPaise: 27_000_000,
  moveInDate: '2024-01-05',
  landlordEmail: 'landlord@example.com',
  createdAt: '2024-01-05T10:00:00.000Z',
} as TenancySummary;

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

function renderSummary(rooms: RoomDiffView[], props: Record<string, unknown> = {}) {
  return render(
    <ConditionSummary tenancy={tenancy} rooms={rooms} phase="MOVEOUT" {...props} />,
  );
}

describe('ConditionSummary — recording a decision', () => {
  it('offers no decision controls when the screen is read-only', () => {
    renderSummary([room([change()])]);
    expect(screen.queryByTestId('accept-chg_1')).toBeNull();
    expect(screen.queryByTestId('reject-chg_1')).toBeNull();
  });

  it('sends ACCEPT for the change the tenant included, with its room', () => {
    const onDecideChange = vi.fn();
    renderSummary([room([change()])], { onDecideChange });

    fireEvent.click(screen.getByTestId('accept-chg_1'));

    expect(onDecideChange).toHaveBeenCalledTimes(1);
    expect(onDecideChange).toHaveBeenCalledWith('room_1', 'chg_1', 'ACCEPT');
  });

  it('sends REJECT for the change the tenant left out', () => {
    const onDecideChange = vi.fn();
    renderSummary([room([change()])], { onDecideChange });

    fireEvent.click(screen.getByTestId('reject-chg_1'));

    expect(onDecideChange).toHaveBeenCalledWith('room_1', 'chg_1', 'REJECT');
  });

  it('reports the current disposition through aria-pressed, not by disabling', () => {
    renderSummary([room([change({ tenantAction: 'ACCEPT' })])], {
      onDecideChange: vi.fn(),
    });

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
    renderSummary([room([change({ tenantAction: 'ACCEPT' })])], { onDecideChange });

    fireEvent.click(screen.getByTestId('reject-chg_1'));
    expect(onDecideChange).toHaveBeenCalledWith('room_1', 'chg_1', 'REJECT');
  });

  it('disables both controls while a decision is in flight', () => {
    renderSummary([room([change()])], { onDecideChange: vi.fn(), deciding: true });

    expect((screen.getByTestId('accept-chg_1') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('reject-chg_1') as HTMLButtonElement).disabled).toBe(true);
  });

  it('routes a decision to the room the change belongs to, not the first room', () => {
    const onDecideChange = vi.fn();
    renderSummary(
      [
        room([change({ id: 'chg_a' })], { roomId: 'room_a', roomLabel: 'Kitchen' }),
        room([change({ id: 'chg_b' })], { roomId: 'room_b', roomLabel: 'Bathroom' }),
      ],
      { onDecideChange },
    );

    fireEvent.click(screen.getByTestId('accept-chg_b'));
    expect(onDecideChange).toHaveBeenCalledWith('room_b', 'chg_b', 'ACCEPT');
  });

  it('offers the same controls for a tenant-authored change, so it can be withdrawn', () => {
    const onDecideChange = vi.fn();
    renderSummary(
      [
        room([
          change({ id: 'chg_t', source: 'TENANT', confidence: 1, tenantAction: 'ACCEPT' }),
        ]),
      ],
      { onDecideChange },
    );

    fireEvent.click(screen.getByTestId('reject-chg_t'));
    expect(onDecideChange).toHaveBeenCalledWith('room_1', 'chg_t', 'REJECT');
  });

  it('never labels a tenant-authored change as a model suggestion', () => {
    renderSummary(
      [
        room([
          change({ id: 'chg_t', source: 'TENANT', confidence: 1, tenantAction: 'ACCEPT' }),
        ]),
      ],
      { onDecideChange: vi.fn() },
    );

    // `confidence: 1` on a TENANT change is a compatibility value, not a score.
    // It must never be drawn as one.
    expect(screen.queryByTestId('suggestion-label-chg_t')).toBeNull();
    expect(screen.queryByTestId('confidence-chg_t')).toBeNull();
    expect(screen.queryByText(/model confidence/i)).toBeNull();
  });

  it('shows model confidence only as decoration beside a suggestion', () => {
    renderSummary([room([change({ confidence: 0.62 })])], { onDecideChange: vi.fn() });

    const label = screen.getByTestId('confidence-chg_1');
    expect(label.textContent).toContain('model confidence 0.62');
    // Not a percentage, and not summed into any headline figure.
    expect(screen.getByTestId('total-recorded').textContent).toBe('0');
  });

  it('counts an undecided model suggestion as a suggestion, never as a recorded change', () => {
    renderSummary([room([change()])], { onDecideChange: vi.fn() });

    expect(screen.getByTestId('total-recorded').textContent).toBe('0');
    expect(screen.getByTestId('suggestions-banner')).toBeTruthy();
  });

  it('counts an accepted suggestion as recorded once the tenant accepts it', () => {
    renderSummary([room([change({ tenantAction: 'ACCEPT' })])], {
      onDecideChange: vi.fn(),
    });

    expect(screen.getByTestId('total-recorded').textContent).toBe('1');
    expect(screen.queryByTestId('suggestions-banner')).toBeNull();
  });

  it('treats AI_DISABLED as the ordinary manual path, not an error', () => {
    renderSummary(
      [room([], { status: 'NEEDS_REVIEW', reviewReason: 'AI_DISABLED' })],
      { onDecideChange: vi.fn() },
    );

    expect(screen.getByTestId('reason-room_1').textContent).toMatch(
      /add anything you can see/i,
    );
    // No alarm banner: with the flag off, every room is NEEDS_REVIEW.
    expect(screen.queryByTestId('attention-banner')).toBeNull();
  });

  it('raises the attention banner only for a review reason other than AI_DISABLED', () => {
    renderSummary(
      [room([], { status: 'NEEDS_REVIEW', reviewReason: 'MODEL_ERROR' })],
      { onDecideChange: vi.fn() },
    );

    expect(screen.getByTestId('attention-banner').textContent).toContain(
      '1 room needs a closer look.',
    );
  });
});

describe('ConditionSummary — document access', () => {
  const withLetter = (over: Record<string, unknown> = {}) =>
    renderSummary([room([])], {
      documents: [
        {
          documentId: 'doc_1',
          docType: 'DEMAND_LETTER',
          sha256: 'a'.repeat(64),
          recordRef: 'HND-001',
          createdAt: '2026-01-02T10:00:00.000Z',
          url: 'https://example.invalid/letter.pdf?sig=abc',
          urlExpiresAt: '2026-01-02T10:05:00.000Z',
        },
      ],
      ...over,
    });

  it('offers the signed URL for download', () => {
    withLetter();
    expect(screen.getByTestId('download-doc_1').getAttribute('href')).toContain('letter.pdf');
  });

  it('gives the download a touch target of at least 44px', () => {
    withLetter();
    // WCAG 2.5.8 sets 24px as the floor; a bare inline anchor measured 20px on
    // a phone, which is the device this screen is actually used on.
    expect(screen.getByTestId('download-doc_1').className).toContain('min-h-11');
  });

  it('says the link is temporary rather than implying the document is stored here', () => {
    withLetter();
    expect(screen.getByTestId('document-doc_1').textContent).toMatch(/temporary/i);
  });

  it('shows a preparing state rather than a dead link when there is no URL yet', () => {
    renderSummary([room([])], {
      documents: [
        {
          documentId: 'doc_2',
          docType: 'CONDITION_REPORT',
          sha256: 'b'.repeat(64),
          recordRef: 'HND-002',
          createdAt: '2026-01-02T10:00:00.000Z',
        },
      ],
    });

    expect(screen.queryByTestId('download-doc_2')).toBeNull();
    expect(screen.getByTestId('document-doc_2').textContent).toMatch(/preparing/i);
  });
});
