/**
 * DynamoDB item shapes — architecture.md §6.3 entity model, keyed per the §6.2
 * access-pattern table.
 *
 * These are the persisted shapes, not the wire shapes. They are deliberately
 * types rather than Zod schemas: items are written by our own adapters through
 * the key builders in `./keys.js`, so the trust boundary that needs runtime
 * validation is the API edge (`../schemas/`) and the model output
 * (`../schemas/diff.js`), not our own writes.
 *
 * Every item carries `entityType` as a discriminant, because AP-2 ("get full
 * tenancy") returns rooms, photos, diffs and documents in one query result and
 * something has to sort them without parsing sort keys.
 */
import type { Paise } from './paise.js';
import type {
  DiffStatus,
  DocumentType,
  JobStatus,
  JobType,
  Phase,
  TenancyStatus,
} from '../constants/enums.js';
import type { DiffChange } from '../schemas/diff.js';

/** ISO-8601 instant, e.g. `2026-09-19T09:00:00.000Z`. Server clock only (§5.4). */
export type IsoDateTime = string;
/** ISO-8601 calendar date, e.g. `2026-09-19`. Sorts lexicographically (AP-5). */
export type IsoDate = string;

export const ENTITY_TYPES = [
  'TENANCY',
  'ROOM',
  'PHOTO',
  'DIFF',
  'DOCUMENT',
  'JOB',
  'STATE_RULE',
  'DIFF_CACHE',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Base every item shares. `PK`/`SK` are always produced by `./keys.js`. */
export interface BaseItem {
  PK: string;
  SK: string;
  entityType: EntityType;
  /** Optimistic-concurrency counter for conditional writes. */
  version?: number;
}

/** `PK=TENANCY#<id>`, `SK=META`. AP-1. */
export interface TenancyItem extends BaseItem {
  entityType: 'TENANCY';
  tenancyId: string;
  /** Cognito sub, from token claims — never from a request body (§7). */
  ownerSub: string;
  addressLine: string;
  city: string;
  stateCode: string;
  monthlyRentPaise: Paise;
  depositPaise: Paise;
  moveInDate: IsoDate;
  /** Set when the tenant schedules/records handover; drives the refund clock. */
  handoverDate?: IsoDate;
  landlordEmail: string;
  status: TenancyStatus;
  /** moveOut/handover + the state's refund window. Mirrored into GSI2SK. */
  refundDueDate?: IsoDate;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** AP-4. Always written. */
  GSI1PK: string;
  GSI1SK: string;
  /**
   * AP-5. Sparse — written only while `status === 'AWAITING_REFUND'` and
   * removed on exit. Its presence is what puts the tenancy on the daily sweep.
   */
  GSI2PK?: string;
  GSI2SK?: IsoDate;
  /** Idempotency guard for clock-sweeper (§5.7, §8.3). */
  lastNotifiedAt?: IsoDateTime;
  /** Per-tenancy model-invocation budget (§9.4). */
  modelInvocationCount?: number;
  /** Rolling send counter for the ≤5/day abuse control (§7 send). */
  sendCountToday?: number;
  sendCountDate?: IsoDate;
}

/** `PK=TENANCY#<id>`, `SK=ROOM#<roomId>`. */
export interface RoomItem extends BaseItem {
  entityType: 'ROOM';
  tenancyId: string;
  roomId: string;
  label: string;
  orderIndex: number;
  /** Maintained by `photo-ingest` with an atomic `ADD` (§6.4). */
  photoCountMovein: number;
  photoCountMoveout: number;
}

/** `PK=TENANCY#<id>`, `SK=PHOTO#<phase>#<roomId>#<nnnn>`. AP-3. */
export interface PhotoItem extends BaseItem {
  entityType: 'PHOTO';
  tenancyId: string;
  roomId: string;
  photoId: string;
  phase: Phase;
  s3Key: string;
  /** Streamed digest of the stored original, which is never rewritten (§5.4). */
  sha256: string;
  bytes: number;
  /** Extracted from EXIF, not trusted as authoritative. */
  exifCapturedAt?: IsoDateTime;
  exifGps?: string;
  /** Server clock. This is the timestamp the record attests to (§5.4). */
  receivedAt: IsoDateTime;
  /** Ordinal within `(phase, roomId)`; the `<nnnn>` of the sort key. */
  pairIndex: number;
}

/** `PK=TENANCY#<id>`, `SK=DIFF#<roomId>`. */
export interface DiffItem extends BaseItem {
  entityType: 'DIFF';
  tenancyId: string;
  roomId: string;
  status: DiffStatus;
  changes: DiffChange[];
  modelId?: string;
  promptVersion?: string;
  cacheKey?: string;
  computedAt?: IsoDateTime;
}

/** `PK=TENANCY#<id>`, `SK=DOCUMENT#<documentId>`. */
export interface DocumentItem extends BaseItem {
  entityType: 'DOCUMENT';
  tenancyId: string;
  documentId: string;
  docType: DocumentType;
  s3Key: string;
  sha256: string;
  /** Human-readable footer record id printed on the PDF. */
  recordRef: string;
  /** Delivery proof and double-send guard (§5.6). Absent until sent. */
  sesMessageId?: string;
  sentAt?: IsoDateTime;
  createdAt: IsoDateTime;
}

/** `PK=JOB#<jobId>`, `SK=META`. AP-6. */
export interface JobItem extends BaseItem {
  entityType: 'JOB';
  jobId: string;
  tenancyId: string;
  jobType: JobType;
  status: JobStatus;
  progressTotal: number;
  progressDone: number;
  /** Where the result landed — a documentId, or the diff collection. */
  resultRef?: string;
  errorCode?: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** DynamoDB TTL, epoch seconds. Job records live 7 days (§6.4). */
  ttl: number;
}

/**
 * `PK=STATE#<code>`, `SK=RULES`. AP-7.
 *
 * §9.2 puts statutory references, deadlines, authority names and the
 * escalation ladder in a data table precisely so they are auditable and
 * updatable without touching a prompt. Nothing here may come from a model.
 */
export interface StateRuleItem extends BaseItem {
  entityType: 'STATE_RULE';
  stateCode: string;
  stateName: string;
  mtaAdopted: boolean;
  depositCapMonths: number;
  refundWindowDays: number;
  /**
   * Statutory interest as **basis points**, not a decimal percent (§6.3:
   * `int statutory_interest_bps`; `600 bps = 6.00% per annum`). A float rate
   * multiplied into an integer-paise principal reintroduces exactly the float
   * error §6.4 forbids; basis points keep interest in integer arithmetic.
   */
  statutoryInterestBps: number;
  authorityName: string;
  escalationSteps: EscalationStep[];
  statuteRefs: StatuteRef[];
  updatedAt: IsoDateTime;
}

export interface EscalationStep {
  order: number;
  label: string;
  description: string;
  /** Days after the refund deadline at which this step becomes available. */
  afterDays?: number;
}

export interface StatuteRef {
  citation: string;
  title: string;
  url?: string;
}

/**
 * `PK=DIFFCACHE#<hashpair>`, `SK=RESULT`. AP-8.
 * Keyed on `sha256(beforeHash + afterHash + promptVersion)` (§5.5, §9.4), so a
 * prompt change invalidates the cache by construction.
 */
export interface DiffCacheItem extends BaseItem {
  entityType: 'DIFF_CACHE';
  cacheKey: string;
  changes: DiffChange[];
  modelId: string;
  promptVersion: string;
  computedAt: IsoDateTime;
  /** DynamoDB TTL, epoch seconds. Diff cache lives 90 days (§6.4). */
  ttl: number;
}

/** Anything the table can hold. Discriminate on `entityType`. */
export type HandoverItem =
  | TenancyItem
  | RoomItem
  | PhotoItem
  | DiffItem
  | DocumentItem
  | JobItem
  | StateRuleItem
  | DiffCacheItem;

/** Narrow an AP-2 query result to one entity type. */
export function isEntity<T extends HandoverItem['entityType']>(
  item: HandoverItem,
  type: T,
): item is Extract<HandoverItem, { entityType: T }> {
  return item.entityType === type;
}
