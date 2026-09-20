import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DiffChange, JobStatusResponse, RoomDiffView } from '@handover/shared';
import { demoDiff } from '../../lib/demo/diff.js';
import { demoConditionReport, demoTenancy } from '../../lib/demo/tenancy.js';
import { ConditionSummary } from './ConditionSummary.js';

afterEach(cleanup);

const TENANCY = demoTenancy.tenancy;
/**
 * The flag-off world, built explicitly rather than borrowed from `demoDiff`.
 *
 * The demo fixture now seeds suggestions, but AI_DISABLED is still what the
 * real API returns whenever the SSM flag is off — which is the default. These
 * tests cover that path on its own terms, so it cannot stop being exercised
 * just because the demo fixture changed.
 */
const FLAG_OFF_ROOMS: RoomDiffView[] = demoDiff.rooms.map((room) => ({
  ...room,
  changes: [],
  status: 'NEEDS_REVIEW' as const,
  reviewReason: 'AI_DISABLED' as const,
}));

const MODEL_CHANGE: DiffChange = {
  id: 'chg_model_1',
  type: 'STAIN',
  surface: 'WALL',
  location: 'wall left of the window',
  description: 'A dark patch not present in the move-in photograph.',
  confidence: 0.82,
  source: 'MODEL',
  wearAndTear: {
    landlordMayArgue: 'A landlord may argue this needs repainting.',
    tenantsTypicallyCounter: 'Tenants typically counter that this is normal wear and tear.',
  },
};

const TENANT_CHANGE: DiffChange = {
  id: 'chg_tenant_1',
  type: 'CRACK',
  location: 'above the door',
  description: 'Hairline crack about 30cm long.',
  confidence: 1,
  source: 'TENANT',
  tenantAction: 'ACCEPT',
};

function roomWith(changes: DiffChange[], overrides: Partial<RoomDiffView> = {}): RoomDiffView {
  const base = FLAG_OFF_ROOMS[0]!;
  return { ...base, changes, ...overrides };
}

function renderSummary(props: Partial<React.ComponentProps<typeof ConditionSummary>> = {}) {
  return render(
    <ConditionSummary
      tenancy={TENANCY}
      rooms={props.rooms ?? FLAG_OFF_ROOMS}
      phase="MOVEOUT"
      {...props}
    />,
  );
}

describe('ConditionSummary — the flag-off default is the normal path', () => {
  it('renders complete and useful with an empty changes array', () => {
    renderSummary();
    expect(screen.getByTestId('total-rooms').textContent).toBe('4');
    expect(screen.getByTestId('total-recorded').textContent).toBe('0');
    expect(screen.getByTestId('room-list').children).toHaveLength(4);
  });

  it('raises no alarm banner when every room is only AI_DISABLED', () => {
    renderSummary();
    expect(screen.queryByTestId('attention-banner')).toBeNull();
  });

  it('writes AI_DISABLED copy that invites input rather than reporting a failure', () => {
    renderSummary();
    const reason = screen.getByTestId(`reason-${FLAG_OFF_ROOMS[0]!.roomId}`);
    expect(reason.textContent).toContain('Add anything you can see');
    expect(reason.textContent).not.toMatch(/unavailable|failed|error/i);
  });

  it('invites a first change rather than offering a review of nothing', () => {
    renderSummary({ onSelectRoom: vi.fn() });
    expect(screen.getByRole('button', { name: /Add a change in Living Room/ })).toBeDefined();
  });

  it('counts photo pairs, so the ledger is visible with zero changes', () => {
    renderSummary();
    expect(screen.getByTestId('total-pairs').textContent).toBe('8');
  });
});

describe('ConditionSummary — review reasons other than AI_DISABLED', () => {
  it('raises a banner for a room flagged for a real anomaly', () => {
    renderSummary({
      rooms: [roomWith([], { reviewReason: 'LOW_CONFIDENCE' }), ...FLAG_OFF_ROOMS.slice(1)],
    });
    expect(screen.getByTestId('attention-banner').textContent).toContain('1 room needs');
  });

  it('writes distinct copy per reason', () => {
    const roomId = FLAG_OFF_ROOMS[0]!.roomId;

    const { unmount } = renderSummary({
      rooms: [roomWith([], { reviewReason: 'MODEL_ERROR' })],
    });
    expect(screen.getByTestId(`reason-${roomId}`).textContent).toContain('did not run');
    unmount();

    renderSummary({ rooms: [roomWith([], { reviewReason: 'MISSING_PAIR' })] });
    expect(screen.getByTestId(`reason-${roomId}`).textContent).toContain(
      'no matching pair of photographs',
    );
  });

  it('says the evidence is unaffected when the comparison failed', () => {
    renderSummary({ rooms: [roomWith([], { reviewReason: 'MODEL_ERROR' })] });
    expect(screen.getByText(/photographs and their timestamps are unaffected/)).toBeDefined();
  });

  it('flags a room with no before-and-after pair', () => {
    renderSummary({ rooms: [roomWith([], { before: [], after: [] })] });
    expect(screen.getByTestId('missing-pairs-banner').textContent).toContain('no before-and-after');
  });
});

describe('ConditionSummary — a suggestion is never a finding', () => {
  it('counts suggestions separately from what the tenant recorded', () => {
    const roomId = FLAG_OFF_ROOMS[0]!.roomId;
    renderSummary({ rooms: [roomWith([MODEL_CHANGE, TENANT_CHANGE])] });

    expect(screen.getByTestId(`count-${roomId}`).textContent).toContain('1 change recorded');
    expect(screen.getByTestId(`count-${roomId}`).textContent).toContain('1 suggestion to review');
    // The undecided suggestion is not in the recorded total.
    expect(screen.getByTestId('total-recorded').textContent).toBe('1');
  });

  it('labels a model change as a suggestion', () => {
    renderSummary({ rooms: [roomWith([MODEL_CHANGE])] });
    expect(screen.getByTestId('suggestion-label-chg_model_1').textContent).toBe('Suggestion');
    expect(screen.getByText('Not yet decided')).toBeDefined();
  });

  it('styles a suggestion differently from a recorded change', () => {
    renderSummary({ rooms: [roomWith([MODEL_CHANGE, TENANT_CHANGE])] });
    expect(screen.getByTestId('change-chg_model_1').className).toContain('border-dashed');
    expect(screen.getByTestId('change-chg_tenant_1').className).not.toContain('border-dashed');
  });

  it('says nothing suggested is included until it is accepted', () => {
    renderSummary({ rooms: [roomWith([MODEL_CHANGE])] });
    expect(screen.getByTestId('suggestions-banner').textContent).toContain(
      'Nothing suggested is included until you accept it',
    );
  });

  it('counts an accepted suggestion as recorded', () => {
    renderSummary({
      rooms: [roomWith([{ ...MODEL_CHANGE, tenantAction: 'ACCEPT' }])],
    });
    expect(screen.getByTestId('total-recorded').textContent).toBe('1');
    expect(screen.getByText('Included')).toBeDefined();
  });

  it('keeps a rejected change on the record without counting it', () => {
    const roomId = FLAG_OFF_ROOMS[0]!.roomId;
    renderSummary({
      rooms: [roomWith([{ ...MODEL_CHANGE, tenantAction: 'REJECT' }])],
    });
    expect(screen.getByTestId('total-recorded').textContent).toBe('0');
    expect(screen.getByTestId(`count-${roomId}`).textContent).toContain('1 dismissed');
    expect(screen.getByTestId('change-chg_model_1')).toBeDefined();
  });

  it('shows no suggestions banner when there are none', () => {
    renderSummary();
    expect(screen.queryByTestId('suggestions-banner')).toBeNull();
  });
});

describe('ConditionSummary — confidence is decoration', () => {
  it('displays model confidence beside a suggestion', () => {
    renderSummary({ rooms: [roomWith([MODEL_CHANGE])] });
    expect(screen.getByTestId('confidence-chg_model_1').textContent).toContain('0.82');
  });

  it('never attaches a confidence figure to a tenant-authored change', () => {
    renderSummary({ rooms: [roomWith([TENANT_CHANGE])] });
    expect(screen.queryByTestId('confidence-chg_tenant_1')).toBeNull();
  });

  it('shows no aggregate confidence anywhere — it is never arithmetic', () => {
    const second: DiffChange = { ...MODEL_CHANGE, id: 'chg_model_2', confidence: 0.4 };
    const { container } = renderSummary({ rooms: [roomWith([MODEL_CHANGE, second])] });
    // 0.82 and 0.40 appear; no mean, sum or percentage of them does.
    expect(container.textContent).toContain('0.82');
    expect(container.textContent).toContain('0.40');
    expect(container.textContent).not.toMatch(/61%|0\.61|average confidence/i);
  });
});

describe('ConditionSummary — wear and tear is never a verdict', () => {
  it('renders both opposed arguments', () => {
    renderSummary({ rooms: [roomWith([MODEL_CHANGE])] });
    const wear = screen.getByTestId('wear-chg_model_1');
    expect(wear.textContent).toContain('A landlord may argue');
    expect(wear.textContent).toContain('Tenants typically counter');
  });

  it('renders nothing when the note is absent, rather than half of it', () => {
    renderSummary({ rooms: [roomWith([TENANT_CHANGE])] });
    expect(screen.queryByTestId('wear-chg_tenant_1')).toBeNull();
  });
});

describe('ConditionSummary — money and claims', () => {
  it('formats the deposit with Indian digit grouping from the shared helper', () => {
    renderSummary();
    // 20000000 paise = Rs 2,00,000.00
    expect(screen.getByText(/2,00,000\.00/)).toBeDefined();
  });

  it('describes the record as tamper-evident, never as legally admissible', () => {
    const { container } = renderSummary();
    expect(container.textContent).toContain('any later alteration is detectable');
    expect(container.textContent).not.toMatch(/legally admissible|admissible in court/i);
  });
});

describe('ConditionSummary — generating the report', () => {
  it('names the report after the phase', () => {
    const { unmount } = renderSummary({ phase: 'MOVEIN', onGenerateReport: vi.fn() });
    expect(screen.getByTestId('generate-report').textContent).toContain('Condition Report');
    unmount();

    renderSummary({ phase: 'MOVEOUT', onGenerateReport: vi.fn() });
    expect(screen.getByTestId('generate-report').textContent).toContain('Exit Report');
  });

  it('calls back when pressed', () => {
    const onGenerateReport = vi.fn();
    renderSummary({ onGenerateReport });
    fireEvent.click(screen.getByTestId('generate-report'));
    expect(onGenerateReport).toHaveBeenCalledTimes(1);
  });

  it('is available with zero changes recorded — the ledger is the product', () => {
    renderSummary({ onGenerateReport: vi.fn() });
    expect((screen.getByTestId('generate-report') as HTMLButtonElement).disabled).toBe(false);
  });

  it('is disabled while a job is in flight', () => {
    const job: JobStatusResponse = {
      jobId: 'job_1',
      type: 'EXIT_REPORT',
      status: 'RUNNING',
      progressDone: 1,
      progressTotal: 4,
    };
    renderSummary({ onGenerateReport: vi.fn(), job });
    expect((screen.getByTestId('generate-report') as HTMLButtonElement).disabled).toBe(true);
  });

  it('is disabled when there are no rooms at all', () => {
    renderSummary({ rooms: [], onGenerateReport: vi.fn() });
    expect((screen.getByTestId('generate-report') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows real progress from the job, not a spinner', () => {
    const job: JobStatusResponse = {
      jobId: 'job_1',
      type: 'DIFF',
      status: 'RUNNING',
      progressDone: 3,
      progressTotal: 4,
    };
    renderSummary({ onGenerateReport: vi.fn(), job });
    const progress = screen.getByTestId('job-progress').querySelector('progress');
    expect(progress?.value).toBe(3);
    expect(progress?.max).toBe(4);
    expect(screen.getByText('3 of 4 complete')).toBeDefined();
  });

  it('says a failed report leaves the evidence intact', () => {
    const job: JobStatusResponse = {
      jobId: 'job_1',
      type: 'EXIT_REPORT',
      status: 'FAILED',
      progressDone: 0,
      progressTotal: 4,
      errorCode: 'INTERNAL',
    };
    renderSummary({ onGenerateReport: vi.fn(), job });
    expect(screen.getByTestId('job-progress').textContent).toContain(
      'photographs and their timestamps are unaffected',
    );
  });
});

describe('ConditionSummary — documents', () => {
  it('lists a generated document with its record reference and a download', () => {
    // The seeded tenancy now starts before any document exists, so this
    // supplies one rather than depending on the fixture's opening state.
    const doc = demoConditionReport;
    renderSummary({ documents: [doc] });
    expect(screen.getByText('Condition Report')).toBeDefined();
    expect(screen.getByText(`Record ${doc.recordRef}`)).toBeDefined();
    const link = screen.getByRole('link', { name: 'Download PDF' }) as HTMLAnchorElement;
    expect(link.hasAttribute('download')).toBe(true);
  });

  it('offers no send action — email delivery is cut from this build', () => {
    const { container } = renderSummary({ documents: [demoConditionReport] });
    expect(container.textContent).not.toMatch(/email|send to landlord/i);
  });

  it('shows nothing when no document exists yet', () => {
    renderSummary();
    expect(screen.queryByTestId('documents')).toBeNull();
  });
});

describe('ConditionSummary — navigation', () => {
  it('routes to a room for review', () => {
    const onSelectRoom = vi.fn();
    renderSummary({ rooms: [roomWith([TENANT_CHANGE])], onSelectRoom });
    fireEvent.click(screen.getByRole('button', { name: /Review Living Room/ }));
    expect(onSelectRoom).toHaveBeenCalledWith(FLAG_OFF_ROOMS[0]!.roomId);
  });

  it('keeps rooms in the order the tenant walked them', () => {
    renderSummary();
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([
      'Living Room',
      'Kitchen',
      'Bedroom 1',
      'Bathroom 1',
    ]);
  });
});
