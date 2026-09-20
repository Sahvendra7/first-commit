/**
 * `clock-sweeper` — architecture.md §5.7, §6.2 (AP-5), §8.3.
 *
 * §5.7: "the product's thesis, in one function." A deposit is most often lost
 * not to a dispute but to silence — the window closes, nobody says anything,
 * and the tenant finds out months later that they were supposed to act. This
 * runs daily, reads only the tenancies whose deadline has actually lapsed, and
 * marks them overdue so the tenant is told.
 *
 * ── Query, never scan ───────────────────────────────────────────────────────
 * The sparse GSI2 holds a key only while a tenancy is `AWAITING_REFUND`, so
 * this reads O(pending) rather than O(all data). A scan would re-read the
 * whole table every morning and grow with the business instead of with the
 * problem.
 *
 * ── No SES ──────────────────────────────────────────────────────────────────
 * §8.3 has this function emailing the tenant. Delivery is cut from this build
 * (CLAUDE.md "Scope"), so it does not: it advances the state, and the tenant
 * sees `OVERDUE` when they next open the app. The function has no mail client
 * and no recipient, so `demo-safety`'s "no worker sends" is not a rule this
 * file has to remember — there is nothing here that could.
 *
 * ── Idempotency and isolation ───────────────────────────────────────────────
 * A duplicate invocation on the same day changes nothing: `decideSweep`
 * compares `lastNotifiedAt` by calendar day, and the write is conditional on
 * the tenancy still being `AWAITING_REFUND`. One tenancy that fails does not
 * stop the sweep — the others are still due, and a sweep that aborted on the
 * first bad row would leave every tenancy after it unswept.
 *
 * Thin adapter (§5.3): the decisions are `domain/tenancy/refund-clock.ts`.
 */
import {
  getTenancy,
  markTenancyOverdue,
  queryRefundsDueBy,
} from '../../adapters/dynamo/evidence-store.js';
import { decideSweep } from '../../domain/tenancy/refund-clock.js';

export interface SweepDeps {
  readonly now: () => string;
  readonly logger: {
    info(event: string, fields: Record<string, unknown>): void;
    warn(event: string, fields: Record<string, unknown>): void;
  };
}

const defaultLogger: SweepDeps['logger'] = {
  info: (event, fields) => console.log(JSON.stringify({ level: 'INFO', event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ level: 'WARN', event, ...fields })),
};

export interface SweepSummary {
  readonly scanned: number;
  readonly markedOverdue: number;
  readonly skipped: number;
  readonly failed: number;
}

export async function runClockSweep(overrides: Partial<SweepDeps> = {}): Promise<SweepSummary> {
  const deps: SweepDeps = {
    now: overrides.now ?? (() => new Date().toISOString()),
    logger: overrides.logger ?? defaultLogger,
  };

  const now = deps.now();
  const today = now.slice(0, 10);

  const dueIds = await queryRefundsDueBy(today);
  deps.logger.info('clock.sweep.started', { today, candidates: dueIds.length });

  let markedOverdue = 0;
  let skipped = 0;
  let failed = 0;

  for (const tenancyId of dueIds) {
    try {
      const tenancy = await getTenancy(tenancyId);
      if (!tenancy) {
        // A key with no tenancy behind it. Nothing to transition, and nothing
        // this function can safely clean up, so it is counted and logged.
        deps.logger.warn('clock.sweep.tenancy_missing', { tenancyId });
        skipped += 1;
        continue;
      }

      const decision = decideSweep(tenancy, now);
      if (decision.action === 'SKIP') {
        deps.logger.info('clock.sweep.skipped', { tenancyId, reason: decision.reason });
        skipped += 1;
        continue;
      }

      const applied = await markTenancyOverdue(
        tenancyId,
        decision.status,
        decision.lastNotifiedAt,
      );

      if (applied) {
        markedOverdue += 1;
        deps.logger.info('clock.sweep.marked_overdue', {
          tenancyId,
          daysOverdue: decision.daysOverdue,
          refundDueDate: tenancy.refundDueDate,
        });
      } else {
        // The tenancy left AWAITING_REFUND between the read and the write —
        // a tenant resolving the matter while the sweep ran. The winner is
        // right and this is not an error.
        skipped += 1;
        deps.logger.info('clock.sweep.raced', { tenancyId });
      }
    } catch (error) {
      // Per-tenancy isolation, for the same reason the diff worker has it:
      // the rest of the list is still due, and a sweep that aborted on the
      // first bad row would leave everyone after it unswept.
      failed += 1;
      deps.logger.warn('clock.sweep.tenancy_failed', {
        tenancyId,
        error: (error as Error)?.name ?? 'unknown',
      });
    }
  }

  const summary: SweepSummary = {
    scanned: dueIds.length,
    markedOverdue,
    skipped,
    failed,
  };
  deps.logger.info('clock.sweep.finished', { today, ...summary });
  return summary;
}

export async function handler(): Promise<SweepSummary> {
  return runClockSweep();
}
