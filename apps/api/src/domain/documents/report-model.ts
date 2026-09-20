/**
 * The Condition / Exit Report content model — architecture.md §5.6, §8.1,
 * §8.2, §9.7; `demo-safety`.
 *
 * Everything a generated PDF is allowed to say, decided here in pure code
 * before a single byte of PDF exists. The renderer draws this model and makes
 * no decisions of its own, which is what makes "what can this document assert"
 * a question with a unit-testable answer.
 *
 * ── One template, parameterised by phase ────────────────────────────────────
 * CLAUDE.md folds the Exit Report into the Condition Report template: "One PDF
 * template total, parameterised by phase." So this builds one shape either
 * way, and the phase decides what goes in it — move-in photographs alone for a
 * Condition Report, both sides plus the authorised change list for an Exit
 * Report.
 *
 * ── The gate ────────────────────────────────────────────────────────────────
 * §9.7: "the tenant must affirmatively accept each change before it enters a
 * letter." A change reaches this model only with `tenantAction === 'ACCEPT'`.
 * An unreviewed model suggestion does not, however many runs agreed on it; a
 * rejected one does not, whoever wrote it. The filter is positive — it admits
 * what was accepted rather than excluding what was refused — because a new
 * `tenantAction` value added later would then be excluded by default rather
 * than silently let through.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 * No `confidence`: §9.2 forbids the model's number from entering a generated
 * document, so it is dropped here rather than "not rendered" downstream. No
 * verdict about wear and tear — only the two opposed arguments the shared
 * schema carries. No statement about admissibility: the record claims to be
 * dated, hashed and unmodified since capture, which is a claim about itself
 * and is true, rather than a claim about what a court will do with it.
 *
 * Domain module: no AWS imports, no I/O, no clock — `generatedAt` is injected.
 */
import type {
  DiffChange,
  DocumentType,
  HandoverItem,
  IsoDate,
  IsoDateTime,
  Phase,
  PhotoItem,
  RoomItem,
  TenancyItem,
  WearAndTearNote,
} from '@handover/shared';
import type { PersistedDiffItem } from '../diff/persisted.js';

/** §5.6: which document each phase produces. */
const DOC_TYPE_FOR_PHASE: Readonly<Record<Phase, Extract<DocumentType, 'CONDITION_REPORT' | 'EXIT_REPORT'>>> = {
  MOVEIN: 'CONDITION_REPORT',
  MOVEOUT: 'EXIT_REPORT',
};

/**
 * One photograph, as the report states it.
 *
 * `receivedAt` and `exifCapturedAt` are kept as separate fields rather than
 * reconciled into one "taken at": §5.4 makes the server clock the timestamp
 * the record attests to, and EXIF corroboration that is explicitly not
 * authoritative. Collapsing them would lose exactly the distinction that makes
 * the first one worth anything.
 */
export interface ReportPhoto {
  readonly photoId: string;
  readonly phase: Phase;
  readonly pairIndex: number;
  readonly sha256: string;
  readonly bytes: number;
  /** Server clock — what this record attests to. */
  readonly receivedAt: IsoDateTime;
  /** From the file's own metadata. Corroboration, not authority. */
  readonly exifCapturedAt?: IsoDateTime;
  readonly exifGps?: string;
  /** Where the renderer fetches the image from. Never printed. */
  readonly s3Key: string;
}

/**
 * How a recorded change came to be on the document — the visible marker
 * `demo-safety` requires, so a reader can tell a model-derived assertion from
 * one the tenant wrote.
 */
export type ChangeOrigin =
  /** The tenant wrote it. */
  | 'TENANT_RECORDED'
  /** The model proposed it and the tenant accepted it. */
  | 'TENANT_ACCEPTED_SUGGESTION';

export interface RecordedChange {
  readonly id: string;
  readonly type: DiffChange['type'];
  readonly surface?: DiffChange['surface'];
  readonly location: string;
  readonly description: string;
  readonly origin: ChangeOrigin;
  /** Two opposed arguments. There is no boolean here to misread (§9.2). */
  readonly wearAndTear?: WearAndTearNote;
}

export interface ReportRoom {
  readonly roomId: string;
  readonly label: string;
  readonly orderIndex: number;
  readonly movein: readonly ReportPhoto[];
  /** Empty on a Condition Report. */
  readonly moveout: readonly ReportPhoto[];
  /** Empty on a Condition Report — see `buildReportModel`. */
  readonly recordedChanges: readonly RecordedChange[];
}

export interface ReportTenancy {
  readonly tenancyId: string;
  readonly addressLine: string;
  readonly city: string;
  readonly stateCode: string;
  readonly moveInDate: IsoDate;
  readonly handoverDate?: IsoDate;
}

export interface ReportModel {
  readonly docType: Extract<DocumentType, 'CONDITION_REPORT' | 'EXIT_REPORT'>;
  readonly phase: Phase;
  readonly tenancy: ReportTenancy;
  readonly rooms: readonly ReportRoom[];
  readonly generatedAt: IsoDateTime;
  readonly totals: {
    readonly roomCount: number;
    readonly photoCount: number;
    readonly recordedChangeCount: number;
  };
}

export class MissingTenancyError extends Error {
  constructor() {
    super('Cannot build a report for a partition with no TENANCY item');
    this.name = 'MissingTenancyError';
  }
}

/* ── The footer record id ──────────────────────────────────────────────────── */

/** FNV-1a, 32-bit — enough to label a document, and no dependency. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).toUpperCase().padStart(8, '0');
}

const DOC_CODE: Readonly<Record<string, string>> = {
  CONDITION_REPORT: 'CR',
  EXIT_REPORT: 'ER',
  DEMAND_LETTER: 'DL',
};

/**
 * The human-readable record id printed in the footer (§5.6).
 *
 * `HND-CR-20260920-1A2B3C4D`. Deterministic in its three inputs, so the same
 * document regenerated carries the same reference and two different documents
 * of one tenancy never collide.
 *
 * The tenancy id is **hashed rather than embedded**. The reference ends up on
 * a piece of paper that goes to a landlord, and a raw id would be a live
 * handle to a record; a digest still lets support correlate it against the
 * ledger without handing the identifier to whoever is holding the page.
 */
export function recordRefFor(
  tenancyId: string,
  docType: DocumentType,
  generatedAt: IsoDateTime,
): string {
  const day = generatedAt.slice(0, 10).replace(/-/g, '');
  const code = DOC_CODE[docType] ?? 'XX';
  return `HND-${code}-${day}-${fnv1a(`${tenancyId}|${docType}|${generatedAt}`)}`;
}

/* ── Assembly ──────────────────────────────────────────────────────────────── */

function toReportPhoto(photo: PhotoItem): ReportPhoto {
  return {
    photoId: photo.photoId,
    phase: photo.phase,
    pairIndex: photo.pairIndex,
    sha256: photo.sha256,
    bytes: photo.bytes,
    receivedAt: photo.receivedAt,
    s3Key: photo.s3Key,
    ...(photo.exifCapturedAt ? { exifCapturedAt: photo.exifCapturedAt } : {}),
    ...(photo.exifGps ? { exifGps: photo.exifGps } : {}),
  };
}

/**
 * The gate, as a positive filter.
 *
 * Note the `confidence` field's absence from the result: it is not copied and
 * then hidden, it never enters the document model at all (§9.2).
 */
function toRecordedChanges(changes: readonly DiffChange[]): RecordedChange[] {
  return changes
    .filter((change) => change.tenantAction === 'ACCEPT')
    .map((change) => ({
      id: change.id,
      type: change.type,
      ...(change.surface !== undefined ? { surface: change.surface } : {}),
      location: change.location,
      description: change.description,
      origin:
        change.source === 'TENANT'
          ? ('TENANT_RECORDED' as const)
          : ('TENANT_ACCEPTED_SUGGESTION' as const),
      ...(change.wearAndTear !== undefined ? { wearAndTear: change.wearAndTear } : {}),
    }));
}

export interface BuildReportInput {
  /** The AP-2 partition: tenancy, rooms, photos, diffs. */
  readonly items: readonly HandoverItem[];
  readonly phase: Phase;
  /** Injected, so the model is a pure function of its inputs. */
  readonly generatedAt: IsoDateTime;
}

/**
 * Build what the PDF will say.
 *
 * A room with no photographs is kept rather than dropped. An omitted room
 * reads as a room that does not exist; a room printed with no photographs is a
 * fact about the record, and the record is the product.
 */
export function buildReportModel(input: BuildReportInput): ReportModel {
  const { items, phase, generatedAt } = input;

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

  const byRoom = new Map<string, PersistedDiffItem>(diffs.map((d) => [d.roomId, d]));
  const byOrdinal = (a: PhotoItem, b: PhotoItem): number => a.pairIndex - b.pairIndex;

  const reportRooms: ReportRoom[] = [...rooms]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((room) => {
      const mine = photos.filter((p) => p.roomId === room.roomId);

      // A Condition Report is a record of a single moment; there is nothing to
      // compare it against, so a change list on one would be an assertion
      // about a comparison that was never made.
      const recordedChanges =
        phase === 'MOVEOUT' ? toRecordedChanges(byRoom.get(room.roomId)?.changes ?? []) : [];

      return {
        roomId: room.roomId,
        label: room.label,
        orderIndex: room.orderIndex,
        movein: mine.filter((p) => p.phase === 'MOVEIN').sort(byOrdinal).map(toReportPhoto),
        moveout:
          phase === 'MOVEOUT'
            ? mine.filter((p) => p.phase === 'MOVEOUT').sort(byOrdinal).map(toReportPhoto)
            : [],
        recordedChanges,
      };
    });

  return {
    docType: DOC_TYPE_FOR_PHASE[phase],
    phase,
    tenancy: {
      tenancyId: tenancy.tenancyId,
      addressLine: tenancy.addressLine,
      city: tenancy.city,
      stateCode: tenancy.stateCode,
      moveInDate: tenancy.moveInDate,
      ...(tenancy.handoverDate ? { handoverDate: tenancy.handoverDate } : {}),
    },
    rooms: reportRooms,
    generatedAt,
    totals: {
      roomCount: reportRooms.length,
      photoCount: reportRooms.reduce((n, r) => n + r.movein.length + r.moveout.length, 0),
      recordedChangeCount: reportRooms.reduce((n, r) => n + r.recordedChanges.length, 0),
    },
  };
}
