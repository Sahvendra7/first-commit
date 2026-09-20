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

  const field = 'w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-[#1a1a1a] placeholder:text-gray-400 focus:border-transparent focus:ring-2 focus:ring-[#1a1a1a] outline-none transition-all';

  return (
    <form onSubmit={submit} className="rounded-2xl bg-white p-6 shadow-sm border border-gray-100 space-y-4" data-testid="create-tenancy">
      <h1 className="text-xl font-bold text-[#1a1a1a]">Start a tenancy record</h1>
      <p className="text-sm text-gray-500">
        This creates the record your photographs attach to. Karnataka only in this build.
      </p>

      <label className="block text-sm font-medium text-gray-700 mb-1.5">
        Address
        <input
          required
          maxLength={240}
          value={addressLine}
          onChange={(e) => setAddressLine(e.target.value)}
          className={field}
        />
      </label>

      <label className="block text-sm font-medium text-gray-700 mb-1.5">
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
        <label className="block text-sm font-medium text-gray-700 mb-1.5">
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
        <label className="block text-sm font-medium text-gray-700 mb-1.5">
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

      <label className="block text-sm font-medium text-gray-700 mb-1.5">
        Move-in date
        <input
          required
          type="date"
          value={moveInDate}
          onChange={(e) => setMoveInDate(e.target.value)}
          className={field}
        />
      </label>

      <label className="block text-sm font-medium text-gray-700 mb-1.5">
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

      <div>
        <p className="text-sm text-gray-500 mb-2">
          {DEFAULT_ROOM_PRESETS.length} rooms will be created:
        </p>
        <div className="flex flex-wrap gap-2">
          {DEFAULT_ROOM_PRESETS.map((r) => (
            <span key={r.label} className="inline-flex rounded-full px-3 py-1 text-xs font-medium bg-gray-100 text-gray-700">
              {r.label}
            </span>
          ))}
        </div>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-xl bg-[#1a1a1a] px-4 py-3.5 text-sm font-semibold text-white hover:bg-gray-800 transition-colors disabled:opacity-50 min-h-11"
      >
        {busy ? 'Creating…' : 'Create tenancy record'}
      </button>
    </form>
  );
}
