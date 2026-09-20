# Web contract — frontend brief for `feat/web-ui`

**Audience:** a session working on `apps/web` from a fresh clone, with no prior
conversation context. This document is self-contained. It describes the parts of
the frozen `packages/shared` contract that the capture and review flows touch,
the upload flow, and the `?demo=1` fixture format.

**Authority:** `docs/architecture.md` is the specification and it wins over this
file. `packages/shared` is a frozen contract (see `CLAUDE.md`) — **read the
schemas, do not edit them.** If something here disagrees with
`packages/shared/src`, the code is right and this file is stale; fix this file.

Everything below is importable from one place:

```ts
import { /* schemas, types, constants */ } from '@handover/shared';
```

`@handover/shared` is already a workspace dependency of `@handover/web`. It has
no runtime dependency other than Zod and is safe in a browser bundle.

---

## 0. Read this before writing any component

### 0.1 The AI suggestion layer is FLAG-OFF. Build for the flag being off.

The change-detection model sits behind an SSM feature flag that is **off by
default** (`docs/architecture.md` §9.6). It was measured against real photo
pairs: non-deterministic at `temperature: 0`, and confidently wrong. The spec
was amended afterwards, and §9.6 is now titled *"tier 3 is the product"*.

Concretely, for the frontend:

- **The default rendering of every room is zero model changes.** A room the
  model never saw arrives with `status: 'NEEDS_REVIEW'` and
  `reviewReason: 'AI_DISABLED'`, and `changes: []`. That is not an error state,
  not a spinner, and not an empty-state apology. It is the normal path. Design
  the review screen so it looks complete and useful with an empty `changes`
  array, and so model suggestions are an *additive decoration* when they exist.
- **Never render a model change as a finding.** Where suggestions do appear
  (`source: 'MODEL'`), they must be visually distinct from recorded fact and
  labelled as suggestions. Nothing model-derived reaches a PDF without an
  explicit tenant `ACCEPT`.
- **`confidence` is decoration.** The `confidence` field on `DiffChange` is
  model-reported. You may display it. It may never be summed, averaged,
  thresholded in the UI, or shown as a percentage of anything the document
  asserts. The trusted agreement number (`agreementFrequency`, computed by code
  in `apps/api/src/domain/diff/merge.ts`) **deliberately does not cross the
  wire** — it is not on `diffChangeSchema`. Do not add it.
- **Never write a wear-and-tear verdict.** `wearAndTear` is two opposed strings
  (`landlordMayArgue` / `tenantsTypicallyCounter`) precisely so no boolean
  exists to misread. Render both sides or neither.

### 0.2 The change-marking flow is tenant-driven, not model-driven

The tenant is the author of the change list, not a reviewer of the machine's.

- The primary action on the review screen is **"add a change"** —
  `PATCH /v1/tenancies/{id}/diff/{roomId}` with an `additions[]` entry. This
  path works with the flag off, with Bedrock down, and with an empty diff.
  It must be reachable in one tap from any room.
- Accept/reject (`changes[{id, action}]`) is the *secondary* path, live only
  when suggestions exist.
- Tenant additions carry **no `confidence`** — the schema has no field for one.
  A human assertion is not a sampled one. Do not synthesise a value.

### 0.3 The compare slider is the centrepiece

The product is the evidence ledger: paired, hashed, timestamped before/after
photographs. The compare slider is the direct visual expression of that, and it
is what the demo is built around. It should get the most design and polish
effort in the app, and it must be fully functional with zero AI output on
screen.

Everything the slider needs arrives in one request. `GET /v1/tenancies/{id}/diff`
returns, per room, `before[]` and `after[]` arrays of `PhotoRef` with presigned
URLs already attached — no second round trip, no per-photo fetch.

Pair by `pairIndex`: `before[i]` and `after[i]` share a `pairIndex` and are the
same framing of the same spot, captured at the two phases. Rooms are ordered by
the room's `orderIndex`, which is the order the tenant walked the property at
move-in and is preserved at move-out.

Presigned photo URLs expire in **5 minutes** (`urlExpiresAt`). A review session
outlasts that. Handle the expiry — re-fetch the aggregate on image error or on a
timer — rather than letting the slider silently show broken images.

### 0.4 State of the repo, as of this brief

Read this before assuming anything is callable.

- **No API is deployed and no HTTP handler exists yet.** `apps/api/src` today
  contains only the diff domain and the Bedrock adapter (`domain/diff/*`,
  `adapters/bedrock/*`, `prompts/`). None of `handlers/http/*` is written. The
  endpoint table in §3 is the *contract* from `docs/architecture.md` §7 and
  `packages/shared/src/schemas/api.ts` — it is what you build against, not
  something you can curl today.
- **`apps/web/src` is empty scaffolding** — `features/{tenancy,capture,compare,claim}/`,
  `lib/`, `routes/` exist as `.gitkeep` directories, plus `index.css`. Nothing
  else. Dependencies installed: React 18, Vite 6, Tailwind 3, TypeScript 5.7,
  Vitest 3, and `@handover/shared`. **No router, no data-fetching library, no
  Cognito/Amplify auth package is installed yet** — those are your calls to make.
- **`data/state-rules/` holds only a README; the `KA` JSON is not yet written.**
- **Practical consequence:** build the api-client against the Zod schemas, and
  make `?demo=1` (§8) work first. It is the only path that runs end to end
  without a backend, and it doubles as the fixture set for component tests.

#### A known contract gap

`data/state-rules/README.md` says `lastReviewedAt` is "surfaced in the UI", and
`StateRuleItem` carries it — but **`getStateRulesResponseSchema` has no
`lastReviewedAt` field**, so it does not cross the wire. Do not add it:
`packages/shared` is frozen, and a contract change needs a written decision
first (`CLAUDE.md`). Build the state-rules UI without that date, and raise the
gap rather than working around it.

---

## 1. Primitives

From `packages/shared/src/schemas/common.ts`:

| Schema | Type | Shape |
|---|---|---|
| `idSchema` | `string` | 1–64 chars, `^[A-Za-z0-9_-]+$`. URL-safe, no `#` (it is the DynamoDB key separator). |
| `isoDateSchema` | `string` | `YYYY-MM-DD`, and must be a real calendar date. |
| `isoDateTimeSchema` | `string` | ISO-8601 instant **with offset** (`z.string().datetime({ offset: true })`). Server-authoritative — the client never supplies one. |
| `stateCodeSchema` | `string` | Two uppercase letters, e.g. `KA`. Trimmed. |
| `emailSchema` | `string` | RFC-valid, ≤254 chars, trimmed. |
| `sha256Schema` | `string` | Lowercase 64-char hex. |
| `problemSchema` | `Problem` | The error body for **every** endpoint (see §7). |

### Money — integer paise, never a float

From `packages/shared/src/types/paise.ts`. This is a hard constraint across the
whole system (§6.4): a wrong number in a legal letter is a catastrophic failure.

```ts
type Paise = number & { readonly [PaiseBrand]: 'Paise' }; // branded integer
```

Helpers you will need in forms and display:

- `rupeesToPaise(rupees: string | number): Paise` — **pass the form field's
  string** (`"12345.50"`). A fractional `number` is rejected on purpose:
  `1.15 * 100 === 114.99999999999999`. Throws `InvalidPaiseError`.
- `tryToPaise(value: unknown): Paise | undefined` — non-throwing validation.
- `formatRupees(value: Paise, { symbol?, paise? }): string` — Indian digit
  grouping, hand-rolled so it cannot vary with the host's ICU build:
  `₹12,34,567.89`. Use this everywhere money is displayed; do not reach for
  `Intl.NumberFormat`.
- `splitRupees(value: Paise): { rupees, paise }`.

`paiseSchema` (≥ 0) and `positivePaiseSchema` (> 0) are the wire-level guards.
Negatives are rejected everywhere: every money field in this system is a
magnitude, and direction is expressed by which field a value lands in.

Interest **rates** are integer basis points for the same reason:
`600 bps = 6.00% per annum`.

---

## 2. Enums

From `packages/shared/src/constants/enums.ts`. Each is an `as const` tuple, so
it is simultaneously a runtime list you can map over for UI copy, a Zod enum,
and a TS union. Prefer iterating the exported tuple over hardcoding strings.

### Tenancy status — the state machine

```ts
export const TENANCY_STATUSES = [
  'MOVEIN_PENDING',    // created; move-in capture in progress
  'MOVEIN_COMPLETE',   // MOVEIN closed; Condition Report generated
  'MOVEOUT_PENDING',   // handover underway; move-out capture in progress
  'MOVEOUT_COMPLETE',  // MOVEOUT closed; diff run, Exit Report generated
  'AWAITING_REFUND',   // refund window open — the only clock-tracked state
  'OVERDUE',           // window lapsed without full refund (set by clock-sweeper)
  'RESOLVED',          // terminal
] as const;
```

This drives primary navigation: the status tells you which screen the tenancy
should open on. There is deliberately **no `DELETED`** state — the 30-day purge
is out of scope, and an unused enum member invites building it.

`CLOCK_TRACKED_STATUSES = ['AWAITING_REFUND']` — the states the refund clock
watches. Use it rather than re-deriving the rule in the UI.

### The rest

```ts
PHASES                       = ['MOVEIN', 'MOVEOUT']
JOB_TYPES                    = ['CONDITION_REPORT', 'DIFF', 'EXIT_REPORT', 'LETTER']
JOB_STATUSES                 = ['QUEUED', 'RUNNING', 'DONE', 'FAILED']
DOCUMENT_TYPES               = ['CONDITION_REPORT', 'EXIT_REPORT', 'DEMAND_LETTER']
DIFF_STATUSES                = ['PENDING', 'COMPLETE', 'NEEDS_REVIEW']
ALLOWED_PHOTO_CONTENT_TYPES  = ['image/jpeg', 'image/png', 'image/webp']
API_ERROR_CODES              = ['UNKNOWN_STATE', 'INVALID_DEPOSIT', 'TENANCY_QUOTA',
                                'PHASE_ALREADY_COMPLETE', 'INGEST_INCOMPLETE', 'EMPTY_ROOM',
                                'NOT_FOUND', 'FORBIDDEN', 'VALIDATION_FAILED', 'SEND_QUOTA',
                                'INTERNAL']
```

From `schemas/diff.ts`:

```ts
CHANGE_SURFACES = ['WALL','FLOOR','CEILING','DOOR','WINDOW','FIXED_FITTING',
                   'FIXTURE','SANITARYWARE','BUILT_IN_CABINETRY']
CHANGE_TYPES    = ['STAIN','CRACK','HOLE','SCRATCH','DENT','CHIP','BURN',
                   'DISCOLOURATION','MOULD','WATER_DAMAGE','MISSING','BROKEN','OTHER']
CHANGE_SOURCES  = ['MODEL', 'TENANT']
CHANGE_ACTIONS  = ['ACCEPT', 'REJECT']
```

`CHANGE_TYPES` and `CHANGE_SURFACES` are the dropdown options for the
tenant's "add a change" form. Populate them from the tuples.

### Limits — enforce these client-side too

```ts
LIMITS = {
  MIN_ROOMS: 1,
  MAX_ROOMS: 20,
  MAX_PRESIGN_BATCH: 10,             // files per presign call
  MAX_PHOTO_BYTES: 8 * 1024 * 1024,  // per upload, after downscale
  MAX_TENANCIES_PER_USER_PER_DAY: 10,
  MAX_SENDS_PER_TENANCY_PER_DAY: 5,
  MAX_PAIRS_PER_ROOM: 3,             // backend-only: pairs sent to the model
}
```

Client-side enforcement is a UX affordance, not a security boundary — the API
validates independently. But a batch of 11 presign requests is a wasted round
trip and a 422 in front of the user.

### Room presets

`packages/shared/src/constants/rooms.ts` exports `ROOM_PRESETS` (15 entries),
`DEFAULT_ROOM_PRESETS` (the 6 preselected), and `ROOM_PRESET_BY_KEY`.

```ts
interface RoomPreset { key: string; label: string; orderIndex: number; defaultSelected: boolean }
```

The setup form shows all 15 with the 6 defaults checked (Living Room, Kitchen,
Bedroom 1, Bedroom 2, Bathroom 1, Balcony). `orderIndex` is the capture order
and is preserved at move-out so the compare view pairs rooms in the same
sequence the tenant walked them.

---

## 3. Endpoints

Base `/v1`. `Authorization: Bearer <Cognito ID token>` on everything except
`GET /v1/state-rules/{code}` and health. All bodies `application/json`.

Every request schema is `.strict()` — an unknown key is a rejection, not a
silent drop. Notably `ownerSub` is set from token claims and must never appear
in a body.

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/v1/tenancies` | `createTenancyRequestSchema` | 201 `createTenancyResponseSchema` |
| POST | `/v1/tenancies/{id}/photos:presign` | `presignPhotosRequestSchema` | 200 `presignPhotosResponseSchema` |
| POST | `/v1/tenancies/{id}/phases/{phase}/complete` | `completePhaseRequestSchema` | 202 `completePhaseResponseSchema` |
| GET | `/v1/jobs/{jobId}` | — | 200 `jobStatusResponseSchema` |
| GET | `/v1/tenancies/{id}` | — | 200 `getTenancyResponseSchema` |
| GET | `/v1/tenancies/{id}/diff` | — | 200 `getDiffResponseSchema` |
| PATCH | `/v1/tenancies/{id}/diff/{roomId}` | `patchDiffRequestSchema` | 200 `patchDiffResponseSchema` (= `roomDiffSchema`) |
| POST | `/v1/tenancies/{id}/claim` | `createClaimRequestSchema` | 202 `createClaimResponseSchema` |
| GET | `/v1/state-rules/{code}` | — | 200 `getStateRulesResponseSchema` |

Path params have schemas too (`tenancyPathSchema`, `phasePathSchema`,
`roomDiffPathSchema`, `jobPathSchema`, `documentPathSchema`,
`stateRulePathSchema`) — use them to validate route params before building a
URL.

### Not available — do not build against these

- **`POST /v1/tenancies/{id}/documents/{docId}/send` is not implemented.**
  Email delivery (SES) is cut from this build. Documents are generated as PDFs
  and **downloaded by the user**. `sendDocumentRequestSchema` /
  `sendDocumentResponseSchema` still exist in `packages/shared` — leave them
  alone, and do not call the endpoint. `DocumentRef.sentAt` and
  `DocumentRef.sesMessageId` will always be absent; do not build UI that waits
  for them. The download affordance is the terminal action on a document.
- **There is no list-tenancies endpoint.** §7 defines no `GET /v1/tenancies`.
  A tenancy is reached by id. Keep the id in the route and in local storage;
  do not build a dashboard that needs a server-side list.
- No `/users` (Cognito owns identity), no `/photos/{id}` singleton (photos
  always arrive via the aggregate), no search, no admin API.

### State rules: only `KA` exists

Exactly one state rule ships — Karnataka. `GET /v1/state-rules/KA` will be the
only code that resolves; everything else is `422 UNKNOWN_STATE`. (The `KA` seed
JSON is not written yet — see §0.4.) The state field in the setup form should
reflect that (a single option, or a clear message on anything else) rather than
offering 28 states that all fail. The point of the table is that the rules are
data-driven; one entry proves it.

`getStateRulesResponseSchema` is public and CloudFront-cached, contains no
tenancy data, and powers UI copy about deadlines and caps:

```ts
{
  stateCode, stateName, mtaAdopted: boolean,
  depositCapMonths: number,
  refundWindowDays: number,
  statutoryInterestBps: number,        // integer basis points — 600 = 6.00%/yr
  authorityName: string,
  escalationSteps: [{ order, label, description, afterDays? }],
  statuteRefs: [{ citation, title, url? }],
}
```

---

## 4. The shapes

### `CreateTenancyRequest`

```ts
{
  addressLine: string,        // trimmed, 1–240
  city: string,               // trimmed, 1–80
  stateCode: string,          // 'KA'
  monthlyRentPaise: Paise,    // > 0
  depositPaise: Paise,        // > 0 — violation is 422 INVALID_DEPOSIT
  moveInDate: string,         // YYYY-MM-DD
  landlordEmail: string,
  rooms: [{ label: string /* 1–60 */, orderIndex: number /* 0..19 */ }],  // 1–20 rooms
}
```

Response: `{ tenancyId, status: 'MOVEIN_PENDING', rooms: [{ roomId, label }] }`.
Note the response `status` is the literal `'MOVEIN_PENDING'`, and that the
server assigns `roomId` — the client's `orderIndex` is how you correlate the
returned rooms back to the form.

### `TenancySummary`

```ts
{
  tenancyId, status: TenancyStatus,
  addressLine, city, stateCode,
  monthlyRentPaise: Paise, depositPaise: Paise,
  moveInDate: IsoDate,
  handoverDate?: IsoDate,      // set when handover is recorded; drives the clock
  refundDueDate?: IsoDate,     // handover + the state's refund window
  landlordEmail, createdAt: IsoDateTime,
}
```

### `RoomSummary`

```ts
{ roomId, label, orderIndex, photoCountMovein: number, photoCountMoveout: number }
```

The two counts are maintained server-side by `photo-ingest` with an atomic
increment. **They are the truth about what was actually stored** — use them for
the capture checklist's per-room "n photos" state, not a client-side tally of
what you think you uploaded. That distinction is the whole point of §5's R5
mitigation: never show "done" on a client-side assumption.

### `PhotoRef`

```ts
{
  photoId, roomId, phase: 'MOVEIN' | 'MOVEOUT',
  pairIndex: number,           // ordinal within (phase, roomId) — the pairing key
  sha256: string,              // lowercase hex, of the stored object
  bytes: number,
  receivedAt: IsoDateTime,     // SERVER clock — the timestamp the record attests to
  exifCapturedAt?: IsoDateTime,// from EXIF; extracted, NOT trusted as authoritative
  exifGps?: string,
  url: string,                 // presigned GET
  urlExpiresAt: IsoDateTime,   // 5 minutes
}
```

Display discipline: `receivedAt` is what the ledger attests to. If you show
`exifCapturedAt` at all, label it as device-reported. Showing the `sha256` (even
truncated) next to a photo is a feature, not clutter — the tamper-evidence is
the product. Never describe any of it as "legally admissible"; the claim is
tamper-evidence.

### `DiffChange`

```ts
{
  id: string,                     // what PATCH accepts/rejects by
  type: ChangeType,
  surface?: ChangeSurface,
  location: string,               // plain language, e.g. "wall left of the window"
  description: string,            // ≤600
  confidence: number,             // 0–1, MODEL-REPORTED, DECORATION ONLY (§0.1)
  wearAndTear?: { landlordMayArgue: string, tenantsTypicallyCounter: string },
  source: 'MODEL' | 'TENANT',     // defaults to 'MODEL'
  tenantAction?: 'ACCEPT' | 'REJECT',  // undefined until the tenant reviews
}
```

`tenantAction === undefined` means unreviewed. Only `ACCEPT`ed changes may
enter a document.

### `RoomDiff` / `RoomDiffView`

```ts
// roomDiffSchema
{
  roomId, roomLabel,
  status: 'PENDING' | 'COMPLETE' | 'NEEDS_REVIEW',
  changes: DiffChange[],
  modelId?, promptVersion?, cacheKey?, cacheHit?, computedAt?,   // provenance
  reviewReason?: 'SCHEMA_INVALID' | 'LOW_CONFIDENCE' | 'MODEL_ERROR'
               | 'MISSING_PAIR' | 'AI_DISABLED',
}

// roomDiffViewSchema = roomDiffSchema + before/after photos
{ ...RoomDiff, before: PhotoRef[], after: PhotoRef[] }
```

`reviewReason` is there so the UI can explain *why* a room needs input. Write
distinct copy per reason — and remember `AI_DISABLED` is the default, so its
copy must not read like a failure. Something closer to "add anything you see"
than "analysis unavailable".

`GET /v1/tenancies/{id}/diff` →
`{ tenancyId, rooms: RoomDiffView[], needsReviewCount: number }`.
`needsReviewCount` is a convenience count for the "N rooms need your input"
banner. With the flag off this equals the room count — so consider whether that
banner should appear at all in the flag-off default, or whether the screen
should simply present each room for annotation.

### `PatchDiffRequest`

```ts
{
  changes:   [{ id: string, action: 'ACCEPT' | 'REJECT' }],   // defaults to []
  additions: [{                                               // defaults to [], max 50
    type: ChangeType,
    surface?: ChangeSurface,
    location: string,      // trimmed, 1–200
    description: string,   // trimmed, 1–600
  }],
}
```

Both keys default to `[]`, so an additions-only PATCH is a valid, complete
request — which is exactly the tenant-driven path. Response is the full updated
`RoomDiff`; render from the response rather than optimistically patching local
state, so the server's ids for new additions are the ones on screen.

### `DocumentRef`

```ts
{ documentId, docType, sha256, recordRef, createdAt,
  sentAt?, sesMessageId?,        // always absent — SES is cut
  url?, urlExpiresAt? }
```

`recordRef` is the human-readable record id printed in the PDF footer. Show it
alongside the download link — it is how a tenant refers to the document later.

### `GetTenancyResponse` — the aggregate

```ts
{
  tenancy:   TenancySummary,
  rooms:     RoomSummary[],
  photos:    PhotoRef[],        // all phases, flat — group by (phase, roomId)
  diffs:     RoomDiff[],        // note: RoomDiff, NOT RoomDiffView (no before/after)
  documents: DocumentRef[],
}
```

One call gives you the whole screen. The diff endpoint is the one to use when
you need the photo pairs attached per room.

---

## 5. The upload flow

Three legs: **presign → direct POST to S3 → poll the job.** The API never
touches the image bytes.

### Leg 0 — downscale on device, before anything else

Resize the long edge to ~1600px and re-encode at quality 0.8 in a canvas
(`lib/image-resize.ts`). This cuts ~3 MB to ~350 KB: fewer upload failures on
weak networks, ~8× less storage, and it matches the resolution the vision model
consumes. The original device file is **not** retained — a deliberate trade-off
recorded as risk R7.

Capture is `<input type="file" capture="environment" multiple>`. No native app,
no custom camera.

### Leg 1 — presign

```
POST /v1/tenancies/{id}/photos:presign
{ phase: 'MOVEIN' | 'MOVEOUT', roomId, files: [{ clientRef, contentType, bytes }] }
```

- `clientRef` is **your** correlation id (1–64 chars), echoed back so you can
  match each policy to the blob it belongs to. Generate one per file and keep it
  as the key of your upload-queue entry.
- `bytes` is the size **after** downscale, ≤ 8 MB.
- `contentType` ∈ `image/jpeg | image/png | image/webp`.
- Batch ≤ 10 files. Chunk larger selections into multiple presign calls.

Response:

```
{ uploads: [{ clientRef, url, fields: Record<string,string>, s3Key, expiresAt }] }
```

### Leg 2 — direct POST to S3

**This is a presigned POST, not a PUT.** Only a POST policy can enforce
`content-length-range` and content-type server-side; a presigned PUT cannot
bound the upload size, which is an open door for storage-cost abuse. So:

- Build a `FormData`.
- Append **every** entry of `fields` first, in the order given, unchanged. It is
  an opaque policy form — do not reorder, rename, filter or add to it.
- Append the file **last**, under the field name `file`. S3 ignores anything
  after the file part.
- `POST` the `FormData` to `url`. **Do not set `Content-Type`** — let the
  browser set the multipart boundary.
- **Do not send the `Authorization` header.** The signature is in the form. An
  auth header will break the request.
- Success is **`204 No Content`** (S3 POST), not 200. Failures come back as XML,
  not JSON — parse defensively or just surface the status.

```ts
const form = new FormData();
for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
form.append('file', blob);
const res = await fetch(upload.url, { method: 'POST', body: form }); // expect 204
```

Then: per-file retry with backoff, visible per-photo status, and honour
`expiresAt` — re-presign rather than retrying a stale policy. Upload failure at
the property is silent, total evidence loss at the exact moment of capture
(risk R5), so per-photo state must be visible, never a single aggregate bar.

### Leg 2b — ingestion is asynchronous

A 204 means S3 has the object, **not** that the system has the evidence. An S3
event triggers `photo-ingest`, which hashes the object, extracts EXIF, stamps
the server clock and writes the `PHOTO` item plus the atomic room counter. That
lands a moment later. `RoomSummary.photoCountMovein` / `photoCountMoveout` from
`GET /v1/tenancies/{id}` is the only confirmation that counts.

### Leg 3 — close the phase

```
POST /v1/tenancies/{id}/phases/{phase}/complete
{ declaredPhotoCount: number }     // ≥1
→ 202 { jobId, status: 'QUEUED' }
```

`declaredPhotoCount` is the client's count of what it uploaded, reconciled
server-side against ingested items with a 10-second bounded wait. **It is a
checksum, not a source of truth.** A mismatch is `409 INGEST_INCOMPLETE` — which
means "wait and retry", not "fail". Show the discrepancy and let the tenant
retry; never paper over it with a client-side "done".

Other outcomes: `409 PHASE_ALREADY_COMPLETE` (idempotent — the body carries the
existing `jobId`, so treat it as success and resume polling), `422 EMPTY_ROOM`
(some room has no photo for this phase — name the room in the error copy).

`MOVEIN` complete triggers the Condition Report. `MOVEOUT` complete triggers the
diff, then the Exit Report.

### Leg 4 — poll the job

```
GET /v1/jobs/{jobId}
→ { jobId, type, status, progressDone, progressTotal, resultRef?, errorCode? }
```

**Poll at 2-second intervals with backoff.** WebSockets were considered and
rejected: a 30-second job polled by one user does not justify a persistent
connection tier.

`progressDone / progressTotal` is per room for a `DIFF` job — a real progress
bar, not a fake one. Terminal states are `DONE` and `FAILED`. On `DONE`,
`resultRef` points at the result: a `documentId` for document jobs, or the diff
collection. Then re-fetch `GET /v1/tenancies/{id}` or `.../diff`.

On `FAILED`, `errorCode` is present. A failed `DIFF` job is not a failed
move-out — the evidence ledger is intact and the rooms are annotatable. Say so.

### Sequence

```
[downscale] → POST :presign ──→ per file: POST FormData to S3 (expect 204)
                                     ↓ (async) photo-ingest: hash, EXIF, server clock
                                     ↓
                            GET /v1/tenancies/{id} → photoCount* confirms
                                     ↓
              POST /phases/{phase}/complete { declaredPhotoCount } → 202 jobId
                                     ↓
              GET /v1/jobs/{jobId} every 2s w/ backoff → DONE
                                     ↓
              GET /v1/tenancies/{id}/diff → compare slider
```

---

## 6. The claim flow (brief)

```
POST /v1/tenancies/{id}/claim
{
  claimedDeductionsPaise: Paise,       // ≥ 0
  deductionReasons: string[],          // ≤20, each 1–300 chars, defaults to []
  amountReceivedPaise: Paise,          // ≥ 0
  refundReceivedDate?: IsoDate,
}
→ 202 { jobId }
```

Valid only when the tenancy is `AWAITING_REFUND` or later, and the handover date
is in the past. The shortfall and the statutory interest are computed by code in
`apps/api/src/domain/claim` — **the frontend must not compute, preview, or
estimate either number.** Render what the generated letter says. Poll the job,
then download the `DEMAND_LETTER` document.

---

## 7. Errors

Every error is RFC 7807 `problem+json` with a stable `code` — parse with
`problemSchema` and switch on `code`, never on `status` alone or on prose.

```ts
{ type, title, status, detail?, instance?, code: ApiErrorCode,
  errors?: [{ path, message }] }   // field-level, for VALIDATION_FAILED
```

| Code | Typical status | Frontend response |
|---|---|---|
| `UNKNOWN_STATE` | 422 | Only `KA` is seeded — say so. |
| `INVALID_DEPOSIT` | 422 | Deposit must be > 0. |
| `TENANCY_QUOTA` | 429 | ≤10 tenancies/user/day. |
| `PHASE_ALREADY_COMPLETE` | 409 | Not an error — resume with the returned `jobId`. |
| `INGEST_INCOMPLETE` | 409 | Wait and retry; show which photos are missing. |
| `EMPTY_ROOM` | 422 | Name the room; route back to its capture screen. |
| `NOT_FOUND` / `FORBIDDEN` | 404 / 403 | Generic. Do not distinguish in copy. |
| `VALIDATION_FAILED` | 400 | Map `errors[].path` onto form fields. |
| `SEND_QUOTA` | 429 | Unreachable — send is cut. |
| `INTERNAL` | 500 | Retry affordance. |

---

## 8. `?demo=1` — seeded data

> **Status: defined here.** `docs/architecture.md` mentions `?demo=1` twice
> (§18 Phase 3 and Phase 4) as demo insurance against venue wifi, but never
> specifies a format. The format below is this brief's decision, not a spec
> quote. It is frontend-owned: no backend work, no new endpoint, no change to
> `packages/shared`. If you diverge from it, update this section.

### What it is for

The venue wifi will fail. `?demo=1` must render the **complete** flow —
tenancy, capture, compare slider, review, claim, documents — with zero network
calls, indistinguishable from the real thing to anyone watching.

### Rules

1. **Interception lives in exactly one place:** `src/lib/api-client.ts`. If
   `new URLSearchParams(location.search).get('demo') === '1'`, the client
   resolves from fixtures instead of `fetch`. No component, hook or route ever
   checks for demo mode. A component that knows it is in a demo is a component
   whose demo behaviour is untested in production.
2. **Fixtures are typed and parsed, not cast.** Each fixture is validated with
   the same Zod schema the real response uses, at module load:
   `getTenancyResponseSchema.parse(demoTenancy)`. A fixture that drifts from the
   frozen contract then fails a test rather than the demo. Never `as
   GetTenancyResponse`.
3. **Images are bundled, not presigned.** `PhotoRef.url` points at a static
   asset under `public/demo/` (e.g. `/demo/living-room-movein-0.jpg`).
   `urlExpiresAt` is a far-future instant so no expiry logic fires. This is the
   only field whose semantics differ from production, and it is why fixtures
   must never be served to real users.
4. **The flag is off in the demo, because the flag is off in production.** Every
   seeded room is `status: 'NEEDS_REVIEW'`, `reviewReason: 'AI_DISABLED'`,
   `changes: []`. The demo shows the tenant adding changes by hand — that is the
   honest product, and it is the one that works when Bedrock is unreachable.
   Do not seed model suggestions to make the demo look smarter.
5. **Mutations mutate the in-memory fixture.** A demo PATCH appends a
   `source: 'TENANT'` change to the in-memory room and returns the updated
   `RoomDiff`, so accept/reject/add is genuinely interactive. State resets on
   reload. Demo jobs advance `progressDone` on each poll and reach `DONE` after
   a few ticks, so the progress bar is real.
6. **Every demo response is the schema's own shape.** No extra envelope, no
   `isDemo` field on the wire types. `packages/shared` is frozen.
7. **A visible, non-intrusive demo badge.** Persistent, small, unmistakable. A
   screenshot of the demo must never be mistakable for real evidence.

### Layout

```
apps/web/src/lib/demo/
├── index.ts          # isDemoMode(), the fixture-backed api-client branch
├── tenancy.ts        # GetTenancyResponse   — parsed with getTenancyResponseSchema
├── diff.ts           # GetDiffResponse      — parsed with getDiffResponseSchema
├── state-rules.ts    # GetStateRulesResponse for 'KA'
└── jobs.ts           # a JobStatusResponse generator that advances per poll
apps/web/public/demo/
└── <room>-<phase>-<pairIndex>.jpg
```

### Seed content

One tenancy, mid-flow, with enough rooms to scroll and few enough to demo fast.

- **Tenancy:** `status: 'MOVEOUT_COMPLETE'`, Karnataka (`stateCode: 'KA'`, city
  Bengaluru), deposit `20000000` paise (₹2,00,000), monthly rent `4500000`
  paise (₹45,000), a `moveInDate` about a year before the demo date and a
  `handoverDate` a few days before it, `refundDueDate` derived from the KA
  refund window.
- **Rooms:** 4 of the 6 default presets (Living Room, Kitchen, Bedroom 1,
  Bathroom 1), `orderIndex` 0–3, each with `photoCountMovein` and
  `photoCountMoveout` of 2.
- **Photos:** 2 `pairIndex` values per room per phase = 16 `PhotoRef` entries,
  with plausible distinct `sha256` digests (any valid lowercase 64-hex string)
  and `receivedAt` clustered on the two capture days.
- **The star pair:** one room (Living Room, `pairIndex: 0`) where the two images
  show a genuine, obvious defect — the shot the compare slider is built to
  sell. The other pairs should include at least one *distractor*: different
  lighting or a moved chair, no actual damage. That pair is the argument for why
  the AI layer is flag-off, and it is worth having on screen when someone asks.
- **Diffs:** all four rooms `NEEDS_REVIEW` / `AI_DISABLED` / `changes: []`,
  `needsReviewCount: 4`.
- **Documents:** one `CONDITION_REPORT`, created at move-in, with a `recordRef`
  and a `url` pointing at a bundled PDF under `public/demo/`.

Every string in the fixtures is demo content shown to an audience: no real
addresses, no real email addresses (use `landlord@example.com`), no AWS account
ids, no secrets. The repo carries none of those anywhere.

---

## 9. Working rules for this branch

- **Do not edit `packages/shared`.** Item shapes, the diff schema and the API
  schemas were fixed in Phase 0 and are consumed by both apps. If a change looks
  unavoidable, stop and write down the decision before touching code.
- **Do not implement the send endpoint**, do not add an SES adapter, do not
  build anything in §15.3 "Explicitly not built" (landlord accounts, video
  capture, offline capture, payments, analytics dashboards, multi-property
  management, e-signature, account deletion, a public API).
- **Money is integer paise.** Never a float, anywhere, including display code.
- **`scaffold.ts` files containing only `export {}` are placeholders** so empty
  packages typecheck. Delete the file when real code lands; never import from
  one.
- **Never claim something works without running it.** Not "tests pass" — paste
  the run.

```bash
pnpm install
```

```bash
pnpm --filter @handover/web dev
```

```bash
pnpm lint && pnpm typecheck && pnpm test
```
