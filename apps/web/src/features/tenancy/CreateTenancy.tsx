import { useState } from 'react';
import { DEFAULT_ROOM_PRESETS, rupeesToPaise } from '@handover/shared';
import type { CreateTenancyResponse } from '@handover/shared';
import type { HandoverApiClient } from '../../lib/api-client.js';
import { toUserFacingError } from '../../lib/errors.js';

/**
 * The smallest real `POST /v1/tenancies`.
 *
 * Rooms come from `DEFAULT_ROOM_PRESETS` — the six the shared package
 * preselects — rather than a hand-typed list, so the capture checklist and the
 * seed agree by construction.
 *
 * Money is converted with `rupeesToPaise` from the **string** the input holds.
 * That is not fussiness: `1.15 * 100` is `114.99999999999999`, and §6.4 forbids
 * a float anywhere near money. The helper parses the fractional part digit-wise
 * instead.
 *
 * `ownerSub` is absent, and must stay absent: §7 sets it from the verified token
 * claims and never from a body, and every request schema is `.strict()`, so
 * sending one is a rejection rather than a silent ignore.
 */
export interface CreateTenancyProps {
  readonly api: HandoverApiClient;
  readonly onCreated: (created: CreateTenancyResponse) => void;
}

export function CreateTenancy({ api, onCreated }: CreateTenancyProps) {
  const [addressLine, setAddressLine] = useState('');
  const [city, setCity] = useState('Bengaluru');
  const [rent, setRent] = useState('45000');
  const [deposit, setDeposit] = useState('200000');
  const [moveInDate, setMoveInDate] = useState('');
  const [landlordEmail, setLandlordEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const created = await api.createTenancy({
        addressLine: addressLine.trim(),
        city: city.trim(),
        // CLAUDE.md "Scope": one state rule, Karnataka. Offering 28 states that
        // all 422 would be worse than offering the one that resolves.
        stateCode: 'KA',
        monthlyRentPaise: rupeesToPaise(rent),
        depositPaise: rupeesToPaise(deposit),
        moveInDate,
        landlordEmail: landlordEmail.trim(),
        rooms: DEFAULT_ROOM_PRESETS.map((preset) => ({
          label: preset.label,
          orderIndex: preset.orderIndex,
        })),
      });
      onCreated(created);
    } catch (caught) {
      setError(toUserFacingError(caught).detail);
    } finally {
      setBusy(false);
    }
  }

  const field = 'mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm';

  return (
    <form onSubmit={submit} className="space-y-3" data-testid="create-tenancy">
      <h1 className="text-lg font-semibold text-slate-900">Start a tenancy record</h1>
      <p className="text-sm text-slate-600">
        This creates the record your photographs attach to. Karnataka only in this build.
      </p>

      <label className="block text-xs font-medium text-slate-700">
        Address
        <input
          required
          maxLength={240}
          value={addressLine}
          onChange={(e) => setAddressLine(e.target.value)}
          className={field}
        />
      </label>

      <label className="block text-xs font-medium text-slate-700">
        City
        <input
          required
          maxLength={80}
          value={city}
          onChange={(e) => setCity(e.target.value)}
          className={field}
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block text-xs font-medium text-slate-700">
          Monthly rent (₹)
          <input
            required
            inputMode="decimal"
            pattern="\d+(\.\d{1,2})?"
            value={rent}
            onChange={(e) => setRent(e.target.value)}
            className={field}
          />
        </label>
        <label className="block text-xs font-medium text-slate-700">
          Deposit (₹)
          <input
            required
            inputMode="decimal"
            pattern="\d+(\.\d{1,2})?"
            value={deposit}
            onChange={(e) => setDeposit(e.target.value)}
            className={field}
          />
        </label>
      </div>

      <label className="block text-xs font-medium text-slate-700">
        Move-in date
        <input
          required
          type="date"
          value={moveInDate}
          onChange={(e) => setMoveInDate(e.target.value)}
          className={field}
        />
      </label>

      <label className="block text-xs font-medium text-slate-700">
        Landlord email
        <input
          required
          type="email"
          maxLength={254}
          value={landlordEmail}
          onChange={(e) => setLandlordEmail(e.target.value)}
          className={field}
        />
      </label>

      <p className="text-xs text-slate-500">
        {DEFAULT_ROOM_PRESETS.length} rooms will be created:{' '}
        {DEFAULT_ROOM_PRESETS.map((r) => r.label).join(', ')}.
      </p>

      {error ? (
        <p role="alert" className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-slate-900 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        {busy ? 'Creating…' : 'Create tenancy record'}
      </button>
    </form>
  );
}
