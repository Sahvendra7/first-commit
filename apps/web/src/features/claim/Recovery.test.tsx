/**
 * `Recovery` — the claim path, and the numbers it refuses to state.
 *
 * Two properties matter more than anything else on this screen:
 *
 * 1. **Money is integer paise.** `rupeesToPaise` runs on the string the input
 *    holds; no float is produced at any point. `12.34` must reach the API as
 *    `1234`, not as `1233.9999999999998`.
 *
 * 2. **The screen states no computed amount.** The shortfall and the statutory
 *    interest are `domain/claim`'s and appear in the letter. A figure shown here
 *    could disagree with the letter, which CLAUDE.md calls a catastrophic
 *    failure rather than a bug — so it is asserted absent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  GetStateRulesResponse,
  GetTenancyResponse,
  TenancyStatus,
} from '@handover/shared';
import { Recovery } from './Recovery.js';
import { ApiError, NetworkError, type HandoverApiClient } from '../../lib/api-client.js';

afterEach(cleanup);

const RULES: GetStateRulesResponse = {
  stateCode: 'KA',
  stateName: 'Karnataka',
  mtaAdopted: false,
  depositCapMonths: 0,
  refundWindowDays: 30,
  statutoryInterestBps: 0,
  authorityName: 'Court of Small Causes, Bengaluru',
  escalationSteps: [],
  statuteRefs: [],
} as GetStateRulesResponse;

/** A month ago, so the handover date is always safely in the past. */
function pastDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}

function futureDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().slice(0, 10);
}

function tenancyFixture(
  over: { status?: TenancyStatus; handoverDate?: string; noHandover?: boolean } = {},
  documents: GetTenancyResponse['documents'] = [],
): GetTenancyResponse {
  const { status = 'AWAITING_REFUND', noHandover = false } = over;
  // Spelled as a flag rather than `handoverDate: undefined`, because a
  // destructuring default fires on an explicit `undefined` and would have
  // quietly handed this fixture a date in the very test that needs none.
  const handoverDate = noHandover ? undefined : (over.handoverDate ?? pastDate());
  return {
    tenancy: {
      tenancyId: 'ten_1',
      status,
      addressLine: '12 Residency Road',
      city: 'Bengaluru',
      stateCode: 'KA',
      monthlyRentPaise: 4_500_000,
      depositPaise: 27_000_000,
      moveInDate: '2024-01-05',
      ...(handoverDate ? { handoverDate } : {}),
      refundDueDate: '2026-02-01',
      landlordEmail: 'landlord@example.com',
      createdAt: '2024-01-05T10:00:00.000Z',
    },
    rooms: [{ roomId: 'room_1', label: 'Living room', orderIndex: 0 }],
    photos: [{ photoId: 'p1' }, { photoId: 'p2' }],
    diffs: [],
    documents,
  } as unknown as GetTenancyResponse;
}

/** Stable across renders, so `useJob` is not restarted by identity churn. */
function makeApi(over: Partial<HandoverApiClient> = {}): HandoverApiClient {
  return {
    getStateRules: vi.fn().mockResolvedValue(RULES),
    createClaim: vi.fn().mockResolvedValue({ jobId: 'job_letter_1' }),
    getJob: vi.fn().mockResolvedValue({
      jobId: 'job_letter_1',
      type: 'LETTER',
      status: 'DONE',
      progressDone: 1,
      progressTotal: 1,
    }),
    ...over,
  } as unknown as HandoverApiClient;
}

function renderRecovery(
  api: HandoverApiClient,
  tenancy: GetTenancyResponse = tenancyFixture(),
  props: Record<string, unknown> = {},
) {
  return render(<Recovery api={api} tenancy={tenancy} {...props} />);
}

/** The three money/date inputs are reached by their labels' ids. */
function setField(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement;
  fireEvent.change(el, { target: { value } });
}

describe('Recovery — eligibility', () => {
  it('refuses a claim before the refund window has opened, and says why', () => {
    renderRecovery(makeApi(), tenancyFixture({ status: 'MOVEOUT_COMPLETE' }));

    expect(screen.getByTestId('claim-blocked').textContent).toMatch(
      /once the move-out stage is closed and the refund window has opened/i,
    );
    expect(screen.queryByTestId('submit-claim')).toBeNull();
  });

  it('refuses a claim with no handover date on the record', () => {
    renderRecovery(makeApi(), tenancyFixture({ noHandover: true }));

    expect(screen.getByTestId('claim-blocked').textContent).toMatch(/handover date/i);
    expect(screen.queryByTestId('submit-claim')).toBeNull();
  });

  it('refuses a claim when handover has not happened yet', () => {
    const when = futureDate();
    renderRecovery(makeApi(), tenancyFixture({ handoverDate: when }));

    expect(screen.getByTestId('claim-blocked').textContent).toContain(when);
  });

  it('offers the form once the tenancy is claimable', () => {
    renderRecovery(makeApi());
    expect(screen.getByTestId('submit-claim')).toBeTruthy();
    expect(screen.queryByTestId('claim-blocked')).toBeNull();
  });
});

describe('Recovery — the facts it shows', () => {
  it('shows the deposit from the tenancy record', () => {
    renderRecovery(makeApi());
    expect(screen.getByTestId('deposit-held').textContent).toBe('₹2,70,000.00');
  });

  it('shows the refund deadline the record carries', () => {
    renderRecovery(makeApi());
    expect(screen.getByTestId('refund-due').textContent).toBe('2026-02-01');
  });

  it('references the evidence behind the claim', () => {
    renderRecovery(makeApi());
    expect(screen.getByTestId('evidence-count').textContent).toContain('2 photographs');
    expect(screen.getByTestId('evidence-count').textContent).toContain('1 room');
  });
});

describe('Recovery — money is integer paise', () => {
  it('sends whole rupees as paise', async () => {
    const createClaim = vi.fn().mockResolvedValue({ jobId: 'job_letter_1' });
    renderRecovery(makeApi({ createClaim }));

    setField('claim-deductions', '5000');
    setField('claim-received', '0');
    fireEvent.click(screen.getByTestId('submit-claim'));

    await waitFor(() => expect(createClaim).toHaveBeenCalled());
    expect(createClaim.mock.calls[0]?.[1]).toMatchObject({
      claimedDeductionsPaise: 500_000,
      amountReceivedPaise: 0,
    });
  });

  it('converts a fractional amount without float error', async () => {
    const createClaim = vi.fn().mockResolvedValue({ jobId: 'job_letter_1' });
    renderRecovery(makeApi({ createClaim }));

    // 12.34 * 100 in IEEE-754 is 1233.9999999999998. It must arrive as 1234.
    setField('claim-deductions', '12.34');
    setField('claim-received', '0.01');
    fireEvent.click(screen.getByTestId('submit-claim'));

    await waitFor(() => expect(createClaim).toHaveBeenCalled());
    const body = createClaim.mock.calls[0]?.[1];
    expect(body.claimedDeductionsPaise).toBe(1234);
    expect(Number.isInteger(body.claimedDeductionsPaise)).toBe(true);
    expect(body.amountReceivedPaise).toBe(1);
  });

  it('rejects an amount with more than two decimal places', async () => {
    const createClaim = vi.fn();
    renderRecovery(makeApi({ createClaim }));

    setField('claim-deductions', '10.123');
    fireEvent.click(screen.getByTestId('submit-claim'));

    await waitFor(() =>
      expect(screen.getByText(/at most two decimal places/i)).toBeTruthy(),
    );
    expect(createClaim).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric amount', async () => {
    const createClaim = vi.fn();
    renderRecovery(makeApi({ createClaim }));

    setField('claim-deductions', 'five thousand');
    fireEvent.click(screen.getByTestId('submit-claim'));

    await waitFor(() =>
      expect(screen.getByText(/at most two decimal places/i)).toBeTruthy(),
    );
    expect(createClaim).not.toHaveBeenCalled();
  });

  it('rejects a refund date in the future', async () => {
    const createClaim = vi.fn();
    renderRecovery(makeApi({ createClaim }));

    setField('claim-refund-date', futureDate());
    fireEvent.click(screen.getByTestId('submit-claim'));

    await waitFor(() => expect(screen.getByText(/cannot be in the future/i)).toBeTruthy());
    expect(createClaim).not.toHaveBeenCalled();
  });

  it('omits refundReceivedDate entirely when it is blank', async () => {
    const createClaim = vi.fn().mockResolvedValue({ jobId: 'job_letter_1' });
    renderRecovery(makeApi({ createClaim }));

    fireEvent.click(screen.getByTestId('submit-claim'));

    await waitFor(() => expect(createClaim).toHaveBeenCalled());
    expect(createClaim.mock.calls[0]?.[1]).not.toHaveProperty('refundReceivedDate');
  });
});

describe('Recovery — deduction reasons', () => {
  it('collects the reasons the landlord gave', async () => {
    const createClaim = vi.fn().mockResolvedValue({ jobId: 'job_letter_1' });
    renderRecovery(makeApi({ createClaim }));

    setField('claim-reason', 'Repainting the hall');
    fireEvent.click(screen.getByTestId('add-reason'));
    setField('claim-reason', 'Deep cleaning');
    fireEvent.click(screen.getByTestId('add-reason'));

    fireEvent.click(screen.getByTestId('submit-claim'));

    await waitFor(() => expect(createClaim).toHaveBeenCalled());
    expect(createClaim.mock.calls[0]?.[1].deductionReasons).toEqual([
      'Repainting the hall',
      'Deep cleaning',
    ]);
  });

  it('will not add an empty reason', () => {
    renderRecovery(makeApi());
    expect((screen.getByTestId('add-reason') as HTMLButtonElement).disabled).toBe(true);
  });

  it('lets a reason be removed before submitting', async () => {
    const createClaim = vi.fn().mockResolvedValue({ jobId: 'job_letter_1' });
    renderRecovery(makeApi({ createClaim }));

    setField('claim-reason', 'Repainting the hall');
    fireEvent.click(screen.getByTestId('add-reason'));
    fireEvent.click(screen.getByLabelText(/remove reason/i));

    expect(screen.queryByTestId('reason-list')).toBeNull();

    fireEvent.click(screen.getByTestId('submit-claim'));
    await waitFor(() => expect(createClaim).toHaveBeenCalled());
    expect(createClaim.mock.calls[0]?.[1].deductionReasons).toEqual([]);
  });
});

describe('Recovery — the result', () => {
  it('shows each figure the claim was built from', async () => {
    renderRecovery(makeApi());

    setField('claim-deductions', '5000');
    setField('claim-received', '1000');
    fireEvent.click(screen.getByTestId('submit-claim'));

    await waitFor(() => expect(screen.getByTestId('claim-result')).toBeTruthy());
    expect(screen.getByTestId('result-deductions').textContent).toBe('₹5,000.00');
    expect(screen.getByTestId('result-received').textContent).toBe('₹1,000.00');
  });

  it('states no computed amount owed — that is the letter\'s job', async () => {
    renderRecovery(makeApi());

    setField('claim-deductions', '5000');
    setField('claim-received', '1000');
    fireEvent.click(screen.getByTestId('submit-claim'));

    await waitFor(() => expect(screen.getByTestId('claim-result')).toBeTruthy());

    // deposit 270000 − 5000 − 1000 = 264000. That figure is the domain's and
    // must not appear here under any formatting.
    const text = screen.getByTestId('claim-result').textContent ?? '';
    expect(text).not.toContain('2,64,000');
    expect(text).not.toContain('264000');
    expect(text).toMatch(/stated in the letter itself/i);
  });

  it('never claims legal admissibility or a guaranteed recovery', async () => {
    renderRecovery(makeApi());
    fireEvent.click(screen.getByTestId('submit-claim'));

    await waitFor(() => expect(screen.getByTestId('claim-result')).toBeTruthy());
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/admissible|court[- ]proof|guarantee|you will win/i);
  });

  it('offers the letter for download once the aggregate carries one', async () => {
    const tenancy = tenancyFixture({}, [
      {
        documentId: 'doc_1',
        docType: 'DEMAND_LETTER',
        sha256: 'a'.repeat(64),
        recordRef: 'HND-001',
        createdAt: '2026-01-02T10:00:00.000Z',
        url: 'https://example.invalid/letter.pdf?sig=abc',
        urlExpiresAt: '2026-01-02T10:05:00.000Z',
      },
    ] as unknown as GetTenancyResponse['documents']);

    renderRecovery(makeApi(), tenancy);
    fireEvent.click(screen.getByTestId('submit-claim'));

    await waitFor(() => expect(screen.getByTestId('letter-download')).toBeTruthy());
    expect(screen.getByTestId('letter-download').getAttribute('href')).toContain(
      'letter.pdf',
    );
    // A signed URL is temporary access, and the copy says so.
    expect(screen.getByTestId('letter-record-ref').textContent).toMatch(/temporary/i);
  });

  it('does not persist a signed document URL anywhere', async () => {
    const tenancy = tenancyFixture({}, [
      {
        documentId: 'doc_1',
        docType: 'DEMAND_LETTER',
        sha256: 'a'.repeat(64),
        recordRef: 'HND-001',
        createdAt: '2026-01-02T10:00:00.000Z',
        url: 'https://example.invalid/letter.pdf?sig=SECRET',
        urlExpiresAt: '2026-01-02T10:05:00.000Z',
      },
    ] as unknown as GetTenancyResponse['documents']);

    renderRecovery(makeApi(), tenancy);
    fireEvent.click(screen.getByTestId('submit-claim'));
    await waitFor(() => expect(screen.getByTestId('letter-download')).toBeTruthy());

    expect(globalThis.localStorage?.length ?? 0).toBe(0);
    expect(globalThis.sessionStorage?.length ?? 0).toBe(0);
  });

  it('reloads the aggregate when the letter job finishes', async () => {
    const onChanged = vi.fn();
    renderRecovery(makeApi(), tenancyFixture(), { onChanged });

    fireEvent.click(screen.getByTestId('submit-claim'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('reports a failed letter job without implying the evidence is lost', async () => {
    const api = makeApi({
      getJob: vi.fn().mockResolvedValue({
        jobId: 'job_letter_1',
        type: 'LETTER',
        status: 'FAILED',
        progressDone: 0,
        progressTotal: 1,
        errorCode: 'RENDER_FAILED',
      }),
    });
    renderRecovery(api);

    fireEvent.click(screen.getByTestId('submit-claim'));
    await waitFor(() => expect(screen.getByTestId('letter-failed')).toBeTruthy());
    expect(screen.getByTestId('letter-failed').textContent).toMatch(/unaffected/i);
  });
});

describe('Recovery — failures', () => {
  it('disables the button while the claim is being submitted', async () => {
    let release: (value: { jobId: string }) => void = () => {};
    const createClaim = vi.fn(
      () => new Promise<{ jobId: string }>((resolve) => (release = resolve)),
    );
    renderRecovery(makeApi({ createClaim } as Partial<HandoverApiClient>));

    fireEvent.click(screen.getByTestId('submit-claim'));
    await waitFor(() =>
      expect((screen.getByTestId('submit-claim') as HTMLButtonElement).disabled).toBe(true),
    );

    // And a second tap while disabled cannot produce a second claim.
    fireEvent.click(screen.getByTestId('submit-claim'));
    expect(createClaim).toHaveBeenCalledTimes(1);
    release({ jobId: 'job_letter_1' });
  });

  it('surfaces a 409 from the server rather than a blank screen', async () => {
    const createClaim = vi.fn().mockRejectedValue(
      new ApiError({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'VALIDATION_FAILED',
        detail: 'No handover date has been recorded',
      }),
    );
    renderRecovery(makeApi({ createClaim }));

    fireEvent.click(screen.getByTestId('submit-claim'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/not accepted/i);
  });

  it('surfaces a transport failure as retryable', async () => {
    const createClaim = vi.fn().mockRejectedValue(new NetworkError('offline'));
    renderRecovery(makeApi({ createClaim }));

    fireEvent.click(screen.getByTestId('submit-claim'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/could not reach the server/i);
  });

  it('says a route is not deployed distinctly from a real rejection', async () => {
    const createClaim = vi.fn().mockRejectedValue(
      new ApiError({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'INTERNAL',
      }),
    );
    renderRecovery(makeApi({ createClaim }));

    fireEvent.click(screen.getByTestId('submit-claim'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/not available yet/i);
    expect(screen.getByRole('alert').textContent).toMatch(/unaffected/i);
  });

  it('still allows a claim when the state rules cannot be loaded', async () => {
    const api = makeApi({
      getStateRules: vi.fn().mockRejectedValue(new NetworkError('offline')),
    });
    renderRecovery(api);

    await waitFor(() => expect(screen.getByTestId('rules-unavailable')).toBeTruthy());
    expect(screen.getByTestId('submit-claim')).toBeTruthy();
  });

  it('shows the state rules panel when they load', async () => {
    renderRecovery(makeApi());
    await waitFor(() => expect(screen.getByTestId('state-rules')).toBeTruthy());
    expect(screen.getByTestId('rules-unreviewed')).toBeTruthy();
  });
});
