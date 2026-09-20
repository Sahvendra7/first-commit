/**
 * The Demand Letter content model — architecture.md §5.6, §8.3, §9.2, §9.7;
 * `demo-safety`.
 *
 * Everything the demand letter is allowed to say, decided here in pure code.
 * This is the highest-stakes document the system produces: it goes to a
 * landlord, it asserts a debt, and it names a statute. The renderer draws this
 * model and makes no decisions of its own, so "what may this letter assert" is
 * a question with a unit-testable answer.
 *
 * ── No model wrote any of this ──────────────────────────────────────────────
 * §8.3's sequence has the worker call Bedrock to "compose narrative only".
 * That step is **not built**, deliberately. The AI layer is flag-off by
 * default (§9.6, "tier 3 is the product"), the measurements in §9.5 show the
 * model fabricating confidently, and `demo-safety` forbids model-generated
 * legal text outright. A letter composed by a model would be the one document
 * where a fabrication costs a tenant money. So every sentence in the rendered
 * letter is a fixed string in the renderer or a value from this model, and
 * every value in this model came from the ledger, the reviewed rule table or
 * the arithmetic in `domain/claim`.
 *
 * ── Three sources, and nothing else ─────────────────────────────────────────
 *  - **Money and dates** — `computeClaim`. Not one figure is recomputed here;
 *    a second implementation of the shortfall would be a second chance to get
 *    it wrong.
 *  - **Statutory content** — the `StateRuleItem`. No citation, deadline,
 *    authority name or escalation step is written in this file.
 *  - **Evidence** — the stored items. Hashes and server timestamps, carried
 *    through unchanged.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 * No `confidence`, at any provenance: §9.2 keeps the model's number out of
 * generated documents, and the `confidence: 1` a tenant-authored change
 * carries for schema compatibility is not model confidence and must not be
 * shown as one. No verdict about responsibility or wear and tear. No claim
 * about admissibility. And `rules.reviewed` is false whenever the table has no
 * `lastReviewedAt` (R9), so an unreviewed table cannot pass for a reviewed one
 * simply because nothing on the page says otherwise.
 *
 * Domain module: no AWS imports, no I/O, no clock — `generatedAt` is injected.
 */
import type {
  EscalationStep,
  HandoverItem,
  IsoDate,
  IsoDateTime,
  Paise,
  PhotoItem,
  RoomItem,
  StateRuleItem,
  StatuteRef,
  TenancyItem,
} from '@handover/shared';
import type { PersistedDiffItem } from '../diff/persisted.js';
import type { ClaimComputation } from '../claim/compute.js';
import type { RecordedChange, ReportPhoto, ReportTenancy } from './report-model.js';
import { computeClaim } from '../claim/compute.js';
import { MissingTenancyError, toRecordedChanges, toReportPhoto } from './report-model.js';

/** Raised when the tenancy has no handover date — there is no refund clock. */
export class MissingHandoverDateError extends Error {
  constructor() {
    super('Cannot build a demand letter before a handover date is recorded');
    this.name = 'MissingHandoverDateError';
  }
}

/**
 * Raised when the arithmetic says nothing is owed.
 *
 * A demand for zero is not a lesser demand, it is a false one. If the deposit
 * is settled — or the landlord overpaid — there is no debt to assert and the
 * honest answer is to refuse to produce the document rather than to produce
 * one that demands nothing.
 */
export class NothingOwedError extends Error {
  constructor() {
    super('The deposit is settled; there is no shortfall to demand');
    this.name = 'NothingOwedError';
  }
}

/** What the tenant supplied on the claim form. Figures are integer paise. */
export interface LetterClaimInput {
  readonly claimedDeductionsPaise: Paise;
  /**
   * The landlord's stated reasons, carried verbatim.
   *
   * These are printed as *the landlord's assertions*, never as findings. The
   * letter contradicts them with the record; it does not adopt them.
   */
  readonly deductionReasons: readonly string[];
  readonly amountReceivedPaise: Paise;
  readonly refundReceivedDate?: IsoDate;
}

/** One room's evidence, as the annexure states it. */
export interface LetterRoom {
  readonly roomId: string;
  readonly label: string;
  readonly orderIndex: number;
  readonly movein: readonly ReportPhoto[];
  readonly moveout: readonly ReportPhoto[];
  /** Accepted changes only (§9.7), with their origin markers intact. */
  readonly recordedChanges: readonly RecordedChange[];
}

export interface LetterEvidence {
  readonly rooms: readonly LetterRoom[];
  readonly totals: {
    readonly roomCount: number;
    readonly photoCount: number;
    readonly recordedChangeCount: number;
  };
}

/**
 * The statutory frame, copied from the reviewed table.
 *
 * `reviewed` is the R9 signal made explicit rather than left implicit in the
 * absence of a field, so the renderer cannot forget to check it.
 */
export interface LetterRules {
  readonly stateCode: string;
  readonly stateName: string;
  readonly authorityName: string;
  readonly refundWindowDays: number;
  readonly statutoryInterestBps: number;
  readonly escalationSteps: readonly EscalationStep[];
  readonly statuteRefs: readonly StatuteRef[];
  /** False whenever the table carries no `lastReviewedAt`. */
  readonly reviewed: boolean;
  readonly lastReviewedAt?: IsoDate;
}

export interface LetterModel {
  readonly docType: 'DEMAND_LETTER';
  readonly tenancy: ReportTenancy;
  readonly landlordEmail: string;
  readonly claim: ClaimComputation;
  readonly deductionReasons: readonly string[];
  readonly refundReceivedDate?: IsoDate;
  readonly evidence: LetterEvidence;
  readonly rules: LetterRules;
  readonly generatedAt: IsoDateTime;
}

export interface BuildLetterInput {
  /** The AP-2 partition: tenancy, rooms, photos, diffs. */
  readonly items: readonly HandoverItem[];
  /** The reviewed statutory rules for the tenancy's state. */
  readonly rule: StateRuleItem;
  readonly claimInput: LetterClaimInput;
  /** The day the claim is computed as of — injected, never `new Date()`. */
  readonly asOfDate: IsoDate;
  /** Injected, so the model is a pure function of its inputs. */
  readonly generatedAt: IsoDateTime;
}

const byOrdinal = (a: PhotoItem, b: PhotoItem): number => a.pairIndex - b.pairIndex;

/**
 * Build what the demand letter will say.
 *
 * Refuses rather than degrades in the two cases where a letter would assert
 * something untrue: no handover date (no deadline exists yet) and nothing
 * owed (no debt exists at all).
 */
export function buildLetterModel(input: BuildLetterInput): LetterModel {
  const { items, rule, claimInput, asOfDate, generatedAt } = input;

  let tenancy: TenancyItem | undefined;
  const rooms: RoomItem[] = [];
  const photos: PhotoItem[] = [];
  const diffs: PersistedDiffItem[] = [];

  for (const item of items) {
    if (item.entityType === 'TENANCY') tenancy = item;
    else if (item.entityType === 'ROOM') rooms.push(item);
    else if (item.entityType === 'PHOTO') photos.push(item);
    else if (item.entityType === 'DIFF') diffs.push(item);
  }

  if (!tenancy) throw new MissingTenancyError();
  if (!tenancy.handoverDate) throw new MissingHandoverDateError();

  const claim = computeClaim({
    depositPaise: tenancy.depositPaise,
    claimedDeductionsPaise: claimInput.claimedDeductionsPaise,
    amountReceivedPaise: claimInput.amountReceivedPaise,
    handoverDate: tenancy.handoverDate,
    asOfDate,
    rule,
  });

  // Checked after the arithmetic rather than before it, because "is anything
  // owed" is the arithmetic's answer and not a thing to guess at from inputs.
  if (claim.isSettled || claim.outstanding.direction === 'OVERPAID') {
    throw new NothingOwedError();
  }

  const byRoom = new Map<string, PersistedDiffItem>(diffs.map((d) => [d.roomId, d]));

  const letterRooms: LetterRoom[] = [...rooms]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((room) => {
      const mine = photos.filter((ph) => ph.roomId === room.roomId);
      return {
        roomId: room.roomId,
        label: room.label,
        orderIndex: room.orderIndex,
        movein: mine.filter((ph) => ph.phase === 'MOVEIN').sort(byOrdinal).map(toReportPhoto),
        moveout: mine.filter((ph) => ph.phase === 'MOVEOUT').sort(byOrdinal).map(toReportPhoto),
        // The §9.7 gate, reused rather than reimplemented: one positive filter
        // decides what may enter a generated document, for every document.
        recordedChanges: toRecordedChanges(byRoom.get(room.roomId)?.changes ?? []),
      };
    });

  return {
    docType: 'DEMAND_LETTER',
    tenancy: {
      tenancyId: tenancy.tenancyId,
      addressLine: tenancy.addressLine,
      city: tenancy.city,
      stateCode: tenancy.stateCode,
      moveInDate: tenancy.moveInDate,
      handoverDate: tenancy.handoverDate,
    },
    landlordEmail: tenancy.landlordEmail,
    claim,
    deductionReasons: [...claimInput.deductionReasons],
    ...(claimInput.refundReceivedDate !== undefined
      ? { refundReceivedDate: claimInput.refundReceivedDate }
      : {}),
    evidence: {
      rooms: letterRooms,
      totals: {
        roomCount: letterRooms.length,
        photoCount: letterRooms.reduce((n, r) => n + r.movein.length + r.moveout.length, 0),
        recordedChangeCount: letterRooms.reduce((n, r) => n + r.recordedChanges.length, 0),
      },
    },
    rules: {
      stateCode: rule.stateCode,
      stateName: rule.stateName,
      authorityName: rule.authorityName,
      refundWindowDays: rule.refundWindowDays,
      statutoryInterestBps: rule.statutoryInterestBps,
      escalationSteps: [...rule.escalationSteps].sort((a, b) => a.order - b.order),
      statuteRefs: [...rule.statuteRefs],
      // A write is not a review: `updatedAt` never becomes a review date, and
      // neither does today's. Absent stays absent, and `reviewed` says so.
      reviewed: rule.lastReviewedAt !== undefined,
      ...(rule.lastReviewedAt !== undefined ? { lastReviewedAt: rule.lastReviewedAt } : {}),
    },
    generatedAt,
  };
}
