/**
 * DynamoDB key builders — architecture.md §6.2 access-pattern table.
 *
 * Every key string in the system is produced here. Nothing else in the repo may
 * concatenate `TENANCY#` with an id: a typo in a key is a silent data-loss bug
 * that no type checker catches and no test notices until the item is missing.
 *
 * Two invariants hold across all builders:
 *  - `#` is the reserved segment separator, so no id component may contain it.
 *    An id carrying a `#` could otherwise forge a key into another partition.
 *  - Ids must be non-empty after trimming.
 */
import type { Phase } from '../constants/enums.js';

/** Reserved separator. Changing this is a data migration, not a refactor. */
export const KEY_SEP = '#';

/** Sentinel sort keys. */
export const SK_META = 'META';
export const SK_RULES = 'RULES';
export const SK_RESULT = 'RESULT';

/** Key prefixes, exported so adapters can write `begins_with` conditions. */
export const KEY_PREFIX = {
  TENANCY: 'TENANCY',
  ROOM: 'ROOM',
  PHOTO: 'PHOTO',
  DIFF: 'DIFF',
  DOCUMENT: 'DOCUMENT',
  JOB: 'JOB',
  STATE: 'STATE',
  DIFFCACHE: 'DIFFCACHE',
  USER: 'USER',
  CLOCK: 'CLOCK',
} as const;

/** GSI names, so query code never spells them as literals. §6.2 AP-4, AP-5. */
export const GSI1_NAME = 'GSI1';
export const GSI2_NAME = 'GSI2';

/** The single sparse GSI2 partition. §6.2 AP-5. */
export const CLOCK_PENDING_PK = `${KEY_PREFIX.CLOCK}${KEY_SEP}PENDING`;

export class InvalidKeyComponentError extends Error {
  constructor(component: string, value: unknown, reason: string) {
    super(`Invalid key component "${component}" (${reason}): ${String(value)}`);
    this.name = 'InvalidKeyComponentError';
  }
}

function assertComponent(name: string, value: string): string {
  if (typeof value !== 'string') throw new InvalidKeyComponentError(name, value, 'not a string');
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new InvalidKeyComponentError(name, value, 'empty');
  if (trimmed.includes(KEY_SEP)) {
    throw new InvalidKeyComponentError(name, value, `contains the reserved "${KEY_SEP}" separator`);
  }
  return trimmed;
}

/**
 * Photo ordinals are zero-padded so that the lexicographic sort DynamoDB
 * applies to sort keys matches capture order numerically: without padding,
 * `PHOTO#MOVEIN#r1#10` sorts before `PHOTO#MOVEIN#r1#2`.
 */
export const PHOTO_INDEX_WIDTH = 4;
export const MAX_PHOTO_INDEX = 10 ** PHOTO_INDEX_WIDTH - 1;

function assertPhotoIndex(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > MAX_PHOTO_INDEX) {
    throw new InvalidKeyComponentError(
      'n',
      n,
      `must be an integer in 0..${MAX_PHOTO_INDEX}`,
    );
  }
  return String(n).padStart(PHOTO_INDEX_WIDTH, '0');
}

/* ── AP-1 / AP-2 / AP-3: the tenancy partition ─────────────────────────────── */

/** `TENANCY#<id>` — the partition every tenancy child item lives in. */
export function tenancyPk(tenancyId: string): string {
  return `${KEY_PREFIX.TENANCY}${KEY_SEP}${assertComponent('tenancyId', tenancyId)}`;
}

/** `META` — AP-1, tenancy metadata. */
export function tenancyMetaSk(): string {
  return SK_META;
}

/** `ROOM#<roomId>`. */
export function roomSk(roomId: string): string {
  return `${KEY_PREFIX.ROOM}${KEY_SEP}${assertComponent('roomId', roomId)}`;
}

/** `ROOM#` — begins_with prefix for all rooms of a tenancy. */
export function roomSkPrefix(): string {
  return `${KEY_PREFIX.ROOM}${KEY_SEP}`;
}

/** `PHOTO#<phase>#<roomId>#<nnnn>` — AP-3. */
export function photoSk(phase: Phase, roomId: string, n: number): string {
  return `${photoSkPrefix(phase, roomId)}${assertPhotoIndex(n)}`;
}

/** `PHOTO#<phase>#<roomId>#` — the AP-3 begins_with prefix, exactly as specced. */
export function photoSkPrefix(phase: Phase, roomId: string): string {
  return (
    `${KEY_PREFIX.PHOTO}${KEY_SEP}${assertComponent('phase', phase)}` +
    `${KEY_SEP}${assertComponent('roomId', roomId)}${KEY_SEP}`
  );
}

/** `PHOTO#<phase>#` — every photo of a phase, across rooms. */
export function photoSkPhasePrefix(phase: Phase): string {
  return `${KEY_PREFIX.PHOTO}${KEY_SEP}${assertComponent('phase', phase)}${KEY_SEP}`;
}

/** `DIFF#<roomId>` — one diff per room. §8.2. */
export function diffSk(roomId: string): string {
  return `${KEY_PREFIX.DIFF}${KEY_SEP}${assertComponent('roomId', roomId)}`;
}

/** `DIFF#` — begins_with prefix for all room diffs. */
export function diffSkPrefix(): string {
  return `${KEY_PREFIX.DIFF}${KEY_SEP}`;
}

/** `DOCUMENT#<documentId>`. */
export function documentSk(documentId: string): string {
  return `${KEY_PREFIX.DOCUMENT}${KEY_SEP}${assertComponent('documentId', documentId)}`;
}

/** `DOCUMENT#` — begins_with prefix for all generated documents. */
export function documentSkPrefix(): string {
  return `${KEY_PREFIX.DOCUMENT}${KEY_SEP}`;
}

/* ── AP-6: jobs ────────────────────────────────────────────────────────────── */

/** `JOB#<jobId>`. */
export function jobPk(jobId: string): string {
  return `${KEY_PREFIX.JOB}${KEY_SEP}${assertComponent('jobId', jobId)}`;
}

/** `META` — jobs carry a single item. */
export function jobSk(): string {
  return SK_META;
}

/* ── AP-7: state rules ─────────────────────────────────────────────────────── */

/**
 * `STATE#<code>`. The code is upper-cased here so `ka` and `KA` cannot become
 * two partitions holding divergent statutory data.
 */
export function statePk(stateCode: string): string {
  return `${KEY_PREFIX.STATE}${KEY_SEP}${assertComponent('stateCode', stateCode).toUpperCase()}`;
}

/** `RULES`. */
export function stateRulesSk(): string {
  return SK_RULES;
}

/* ── AP-8: diff cache ──────────────────────────────────────────────────────── */

/**
 * `DIFFCACHE#<hashpair>` where hashpair is
 * `sha256(beforeHash + afterHash + promptVersion)` (§5.5, §9.4). This builder
 * takes the computed digest; computing it needs a hash function, which is an
 * adapter concern, not a shared-contract one.
 */
export function diffCachePk(cacheKey: string): string {
  return `${KEY_PREFIX.DIFFCACHE}${KEY_SEP}${assertComponent('cacheKey', cacheKey)}`;
}

/** `RESULT`. */
export function diffCacheSk(): string {
  return SK_RESULT;
}

/* ── AP-4: GSI1, a user's tenancies ────────────────────────────────────────── */

/** `USER#<sub>` — the Cognito sub, taken from token claims, never from a body. */
export function gsi1Pk(ownerSub: string): string {
  return `${KEY_PREFIX.USER}${KEY_SEP}${assertComponent('ownerSub', ownerSub)}`;
}

/** `TENANCY#<createdAt>` — ISO-8601 sorts lexicographically, so newest-last. */
export function gsi1Sk(createdAtIso: string): string {
  return `${KEY_PREFIX.TENANCY}${KEY_SEP}${assertComponent('createdAtIso', createdAtIso)}`;
}

/* ── AP-5: GSI2, the sparse clock ──────────────────────────────────────────── */

/**
 * `CLOCK#PENDING` — written only while a tenancy is `AWAITING_REFUND` and
 * deleted when it leaves that state. That sparseness is what keeps the daily
 * sweep O(pending) rather than O(all data). §6.2.
 */
export function gsi2Pk(): string {
  return CLOCK_PENDING_PK;
}

/** `<dueDateISO>` — the sweep queries `SK <= today`. §6.2 AP-5. */
export function gsi2Sk(dueDateIso: string): string {
  return assertComponent('dueDateIso', dueDateIso);
}

/* ── Composite helpers ─────────────────────────────────────────────────────── */

export interface TableKey {
  readonly PK: string;
  readonly SK: string;
}

export const key = {
  tenancyMeta: (tenancyId: string): TableKey => ({
    PK: tenancyPk(tenancyId),
    SK: tenancyMetaSk(),
  }),
  room: (tenancyId: string, roomId: string): TableKey => ({
    PK: tenancyPk(tenancyId),
    SK: roomSk(roomId),
  }),
  photo: (tenancyId: string, phase: Phase, roomId: string, n: number): TableKey => ({
    PK: tenancyPk(tenancyId),
    SK: photoSk(phase, roomId, n),
  }),
  diff: (tenancyId: string, roomId: string): TableKey => ({
    PK: tenancyPk(tenancyId),
    SK: diffSk(roomId),
  }),
  document: (tenancyId: string, documentId: string): TableKey => ({
    PK: tenancyPk(tenancyId),
    SK: documentSk(documentId),
  }),
  job: (jobId: string): TableKey => ({ PK: jobPk(jobId), SK: jobSk() }),
  stateRule: (stateCode: string): TableKey => ({
    PK: statePk(stateCode),
    SK: stateRulesSk(),
  }),
  diffCache: (cacheKey: string): TableKey => ({
    PK: diffCachePk(cacheKey),
    SK: diffCacheSk(),
  }),
} as const;
