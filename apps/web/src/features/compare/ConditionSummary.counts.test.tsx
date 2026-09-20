/**
 * What the condition summary counts, and what it refuses to count.
 *
 * The accept/reject controls themselves moved to `ChangeReview`, on the room's
 * own screen, and their tests went with them (`ChangeReview.test.tsx`). What
 * stays here is this screen's own job: turning a set of rooms into three
 * headline numbers and a small set of banners without ever letting an undecided
 * model suggestion be counted as something the tenant recorded.
 *
 * The rule underneath is still §9.7 — "the tenant must affirmatively accept
 * each change" — expressed here as arithmetic rather than as a control.
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

describe('ConditionSummary — what the headline numbers may claim', () => {
  it('counts an undecided model suggestion as a suggestion, never as a recorded change', () => {
    renderSummary([room([change()])]);

    expect(screen.getByTestId('total-recorded').textContent).toBe('0');
    expect(screen.getByTestId('suggestions-banner')).toBeTruthy();
  });

  it('counts an accepted suggestion as recorded once the tenant accepts it', () => {
    renderSummary([room([change({ tenantAction: 'ACCEPT' })])]);

    expect(screen.getByTestId('total-recorded').textContent).toBe('1');
    expect(screen.queryByTestId('suggestions-banner')).toBeNull();
  });

  it('counts a rejected suggestion as neither recorded nor waiting', () => {
    renderSummary([room([change({ tenantAction: 'REJECT' })])]);

    expect(screen.getByTestId('total-recorded').textContent).toBe('0');
    expect(screen.queryByTestId('suggestions-banner')).toBeNull();
  });

  it('counts a tenant-authored change as recorded without any decision', () => {
    renderSummary([room([change({ source: 'TENANT', confidence: 1 })])]);

    expect(screen.getByTestId('total-recorded').textContent).toBe('1');
    expect(screen.queryByTestId('suggestions-banner')).toBeNull();
  });

  it('never renders a model confidence on this screen', () => {
    renderSummary([room([change({ confidence: 0.62 })])]);

    // The number belongs beside the change it describes, which is a screen away.
    expect(screen.queryByText(/model confidence/i)).toBeNull();
    expect(screen.getByTestId('total-recorded').textContent).toBe('0');
  });
});

describe('ConditionSummary — the room card is a summary, not a review', () => {
  it('renders no decision controls on a room card', () => {
    renderSummary([room([change()])], { onSelectRoom: vi.fn() });

    expect(screen.queryByTestId('accept-chg_1')).toBeNull();
    expect(screen.queryByTestId('reject-chg_1')).toBeNull();
  });

  it('does not put the change list itself on the card', () => {
    renderSummary([room([change()])], { onSelectRoom: vi.fn() });

    expect(screen.queryByTestId('change-chg_1')).toBeNull();
    expect(screen.queryByText('A dark mark about the size of a hand.')).toBeNull();
  });

  it('shows how many changes are waiting, and offers the way in', () => {
    const onSelectRoom = vi.fn();
    renderSummary([room([change()])], { onSelectRoom });

    expect(screen.getByTestId('pending-room_1').textContent).toContain('1 change to review');

    fireEvent.click(screen.getByRole('button', { name: /review living room/i }));
    expect(onSelectRoom).toHaveBeenCalledWith('room_1');
  });

  it('makes the whole card the control, so the photographs are tappable', () => {
    renderSummary([room([])], { onSelectRoom: vi.fn() });

    const card = screen.getByTestId('room-room_1');
    expect(card.querySelector('button')).not.toBeNull();
  });
});

describe('ConditionSummary — banners', () => {
  it('treats AI_DISABLED as the ordinary manual path, not an error', () => {
    renderSummary([room([], { status: 'NEEDS_REVIEW', reviewReason: 'AI_DISABLED' })]);

    // No alarm banner: with the flag off, every room is NEEDS_REVIEW.
    expect(screen.queryByTestId('attention-banner')).toBeNull();
  });

  it('raises the attention banner only for a review reason other than AI_DISABLED', () => {
    renderSummary([room([], { status: 'NEEDS_REVIEW', reviewReason: 'MODEL_ERROR' })]);

    expect(screen.getByTestId('attention-banner').textContent).toContain(
      '1 room needs a closer look.',
    );
  });

  it('points the tenant at the room when a suggestion is waiting', () => {
    renderSummary([room([change()])]);

    expect(screen.getByTestId('suggestions-banner').textContent).toMatch(/open a room/i);
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
