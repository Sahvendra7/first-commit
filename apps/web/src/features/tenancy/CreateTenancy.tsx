import { useState } from 'react';
import { DEFAULT_ROOM_PRESETS, rupeesToPaise } from '@handover/shared';
import type { CreateTenancyResponse } from '@handover/shared';
import type { HandoverApiClient } from '../../lib/api-client.js';
import { toUserFacingError } from '../../lib/errors.js';
import { Badge, Banner, Button, Field } from '../../ui/index.js';

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

  return (
    <form
      onSubmit={submit}
      className="enter mx-auto w-full max-w-measure"
      data-testid="create-tenancy"
    >
      <p className="text-micro font-semibold uppercase text-ink-3">New record</p>
      <h1 className="mt-1 font-display text-title text-ink">Start a tenancy record</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">
        This is the record your photographs attach to. You can start it on the day you get
        the keys and come back to it at move-out.
      </p>

      <div className="mt-6 space-y-5 rounded-2xl border border-line bg-surface p-5 shadow-sm sm:p-6">
        <Field
          id="tenancy-address"
          label="Address"
          required
          maxLength={240}
          value={addressLine}
          onChange={(e) => setAddressLine(e.target.value)}
        />

        <Field
          id="tenancy-city"
          label="City"
          required
          maxLength={80}
          value={city}
          onChange={(e) => setCity(e.target.value)}
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            id="tenancy-rent"
            label="Monthly rent (₹)"
            required
            inputMode="decimal"
            pattern="\d+(\.\d{1,2})?"
            value={rent}
            onChange={(e) => setRent(e.target.value)}
          />
          <Field
            id="tenancy-deposit"
            label="Deposit (₹)"
            hint="The amount you want back."
            required
            inputMode="decimal"
            pattern="\d+(\.\d{1,2})?"
            value={deposit}
            onChange={(e) => setDeposit(e.target.value)}
          />
        </div>

        <Field
          id="tenancy-move-in"
          label="Move-in date"
          required
          type="date"
          value={moveInDate}
          onChange={(e) => setMoveInDate(e.target.value)}
        />

        <Field
          id="tenancy-landlord-email"
          label="Landlord email"
          hint="Where the demand letter would be addressed. Nothing is sent from this app."
          required
          type="email"
          maxLength={254}
          value={landlordEmail}
          onChange={(e) => setLandlordEmail(e.target.value)}
        />
      </div>

      {/*
        The checklist, shown before it is created rather than discovered after.
        It comes from `DEFAULT_ROOM_PRESETS` so the capture list and the seed
        agree by construction.
      */}
      <div className="mt-5 rounded-2xl border border-line bg-sunk p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">Rooms to walk</h2>
          <span className="tnum text-xs text-ink-3">{DEFAULT_ROOM_PRESETS.length}</span>
        </div>
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {DEFAULT_ROOM_PRESETS.map((preset) => (
            <li key={preset.label}>
              <Badge tone="neutral" caps={false}>
                {preset.label}
              </Badge>
            </li>
          ))}
        </ul>
        {/*
          Karnataka only in this build (CLAUDE.md "Scope"). Said plainly rather
          than offered as a dropdown of 28 states that would all 422.
        */}
        <p className="mt-3 text-xs leading-relaxed text-ink-3">
          Deposit rules are applied for Karnataka. This build carries that one state.
        </p>
      </div>

      {error ? (
        <Banner role="alert" tone="danger" className="mt-5">
          {error}
        </Banner>
      ) : null}

      <Button type="submit" size="lg" block className="mt-5" disabled={busy}>
        {busy ? 'Creating…' : 'Create tenancy record'}
      </Button>
    </form>
  );
}
