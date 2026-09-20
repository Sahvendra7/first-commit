import { formatRupees, type GetTenancyResponse, type TenancyStatus } from '@handover/shared';
import { Badge, formatReceivedAt } from '../../ui/index.js';
import { JourneyStages } from './JourneyStages.js';

/**
 * The record's masthead: which property, how far along it is, and what is on
 * file.
 *
 * This is the app's centre of gravity, so it is the one place that gets a full
 * display heading and a band of its own. Everything on it is read straight off
 * the aggregate — there is no derived figure here that the server does not
 * already assert, and "last photograph" is the latest `receivedAt` across the
 * photographs rather than a separate activity feed the API does not have.
 */

/** Plain-English status, so the tenant is not reading an enum. */
const STATUS_COPY: Record<TenancyStatus, { readonly label: string; readonly tone: 'neutral' | 'brand' | 'ok' | 'warn' }> = {
  MOVEIN_PENDING: { label: 'Recording move-in', tone: 'brand' },
  MOVEIN_COMPLETE: { label: 'Move-in recorded', tone: 'ok' },
  MOVEOUT_PENDING: { label: 'Recording move-out', tone: 'brand' },
  MOVEOUT_COMPLETE: { label: 'Move-out recorded', tone: 'ok' },
  AWAITING_REFUND: { label: 'Awaiting refund', tone: 'warn' },
  OVERDUE: { label: 'Refund overdue', tone: 'warn' },
  RESOLVED: { label: 'Settled', tone: 'neutral' },
};

export interface PropertyRecordProps {
  readonly tenancy: GetTenancyResponse;
  readonly className?: string;
}

export function PropertyRecord({ tenancy, className }: PropertyRecordProps) {
  const summary = tenancy.tenancy;
  const status = STATUS_COPY[summary.status];

  // The most recent moment the ledger attests to. `receivedAt` is the server
  // clock, so this is a fact about the record rather than about this device.
  const lastReceived = tenancy.photos.reduce<string | undefined>(
    (latest, photo) => (latest === undefined || photo.receivedAt > latest ? photo.receivedAt : latest),
    undefined,
  );

  return (
    <header
      className={['rounded-3xl border border-line bg-surface p-5 shadow-sm sm:p-7', className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-micro font-semibold uppercase text-ink-3">Property record</p>
          <h1 className="mt-1.5 font-display text-title text-ink">{summary.addressLine}</h1>
          <p className="mt-1 text-sm text-ink-2">
            {summary.city} · {summary.stateCode}
          </p>
        </div>
        <Badge tone={status.tone} dot data-testid="tenancy-status">
          {status.label}
        </Badge>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-5 border-t border-line pt-5 sm:grid-cols-4">
        <Fact label="Deposit held" value={formatRupees(summary.depositPaise)} testId="record-deposit" />
        <Fact
          label="Evidence on file"
          value={`${tenancy.photos.length}`}
          note={`${tenancy.photos.length === 1 ? 'photograph' : 'photographs'} · ${
            tenancy.rooms.length === 1 ? '1 room' : `${tenancy.rooms.length} rooms`
          }`}
          testId="record-evidence"
        />
        <Fact label="Moved in" value={summary.moveInDate} testId="record-movein" />
        <Fact
          label="Last photograph"
          value={lastReceived ? formatReceivedAt(lastReceived) : 'None yet'}
          small={lastReceived !== undefined}
          testId="record-last"
        />
      </dl>

      <div className="mt-7 border-t border-line pt-6">
        <JourneyStages status={summary.status} />
      </div>
    </header>
  );
}

function Fact({
  label,
  value,
  note,
  small,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly small?: boolean;
  readonly testId: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-micro font-semibold uppercase text-ink-3">{label}</dt>
      <dd
        data-testid={testId}
        className={[
          'tnum mt-1 font-semibold text-ink',
          small ? 'text-sm leading-snug' : 'text-[1.0625rem]',
        ].join(' ')}
      >
        {value}
      </dd>
      {note ? <dd className="text-xs text-ink-3">{note}</dd> : null}
    </div>
  );
}
