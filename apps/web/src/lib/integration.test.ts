import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GetTenancyResponse, PhotoRef } from '@handover/shared';
import { ApiError, NetworkError, createApiClient, isDemoMode } from './api-client.js';
import { DemoApiClient } from './demo/client.js';
import { demoTenancy, DEMO_TENANCY_ID } from './demo/tenancy.js';
import { awaitIngest, countFor } from './ingest.js';
import {
  firstMatchedPair,
  matchedPairs,
  missingPairReason,
  pairsForRoom,
  resolveRooms,
  roomsFromAggregate,
} from './pairing.js';
import { isRouteNotDeployed, toUserFacingError } from './errors.js';
import { AuthError } from './auth/cognito-auth.js';
import { MemoryStorage } from './auth/memory-storage.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('demo mode stays isolated from production (web-contract §8 rule 1)', () => {
  it('production mode never constructs the fixture client', async () => {
    const client = await createApiClient({ demo: false, baseUrl: 'https://api.invalid' });
    expect(client).not.toBeInstanceOf(DemoApiClient);
  });

  it('production mode makes a real network call rather than returning a fixture', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ message: 'nope' }), { status: 500 }));
    vi.stubGlobal('fetch', fetchSpy);

    const client = await createApiClient({ demo: false, baseUrl: 'https://api.invalid' });
    await client.getTenancy('tn_1').catch(() => undefined);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a production failure surfaces as an error, never as seeded data', async () => {
    vi.stubGlobal('fetch', async () => new Response('gateway down', { status: 502 }));

    const client = await createApiClient({ demo: false, baseUrl: 'https://api.invalid' });
    const result = await client.getTenancy(DEMO_TENANCY_ID).catch((e: unknown) => e);

    expect(result).toBeInstanceOf(ApiError);
    expect(result).not.toMatchObject({ tenancy: expect.anything() });
  });

  it('demo mode issues no network call at all', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const client = await createApiClient({ demo: true });
    await client.getTenancy(DEMO_TENANCY_ID);
    await client.getDiff(DEMO_TENANCY_ID);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('only ?demo=1 turns it on', () => {
    expect(isDemoMode('?demo=1')).toBe(true);
    expect(isDemoMode('?demo=0')).toBe(false);
    expect(isDemoMode('?tenancy=tn_real')).toBe(false);
    expect(isDemoMode('')).toBe(false);
  });
});

describe('ingestion confirmation (web-contract §5 Leg 2b)', () => {
  function tenancyWith(count: number): GetTenancyResponse {
    return {
      ...demoTenancy,
      rooms: demoTenancy.rooms.map((r, i) =>
        i === 0 ? { ...r, photoCountMovein: count } : r,
      ),
    };
  }
  const roomId = demoTenancy.rooms[0]!.roomId;

  it('reads the count from the server aggregate, not a local tally', () => {
    expect(countFor(tenancyWith(7), roomId, 'MOVEIN')).toBe(7);
    expect(countFor(tenancyWith(7), 'rm_unknown', 'MOVEIN')).toBe(0);
  });

  it('confirms once the server count reaches the target', async () => {
    const api = { getTenancy: vi.fn(async () => tenancyWith(3)) } as never;
    const outcome = await awaitIngest({
      api,
      tenancyId: DEMO_TENANCY_ID,
      roomId,
      phase: 'MOVEIN',
      expectedCount: 3,
      sleep: async () => {},
    });
    expect(outcome.status).toBe('CONFIRMED');
  });

  it('keeps polling while the count is still catching up', async () => {
    const counts = [0, 1, 2];
    const api = {
      getTenancy: vi.fn(async () => tenancyWith(counts.shift() ?? 2)),
    } as never;

    const outcome = await awaitIngest({
      api,
      tenancyId: DEMO_TENANCY_ID,
      roomId,
      phase: 'MOVEIN',
      expectedCount: 2,
      sleep: async () => {},
    });

    expect(outcome.status).toBe('CONFIRMED');
    expect((api as { getTenancy: { mock: { calls: unknown[] } } }).getTenancy.mock.calls.length).toBe(3);
  });

  it('reports a timeout as a timeout, never as success', async () => {
    const api = { getTenancy: vi.fn(async () => tenancyWith(1)) } as never;
    let clock = 0;
    const outcome = await awaitIngest({
      api,
      tenancyId: DEMO_TENANCY_ID,
      roomId,
      phase: 'MOVEIN',
      expectedCount: 5,
      timeoutMs: 10,
      sleep: async () => {},
      now: () => (clock += 6),
    });

    expect(outcome.status).toBe('TIMEOUT');
    if (outcome.status === 'TIMEOUT') {
      expect(outcome.ingestedCount).toBe(1);
      expect(outcome.expectedCount).toBe(5);
    }
  });

  it('surfaces a read failure rather than pretending ingestion happened', async () => {
    const api = {
      getTenancy: vi.fn(async () => {
        throw new NetworkError('offline');
      }),
    } as never;

    const outcome = await awaitIngest({
      api,
      tenancyId: DEMO_TENANCY_ID,
      roomId,
      phase: 'MOVEIN',
      expectedCount: 1,
      sleep: async () => {},
    });
    expect(outcome.status).toBe('ERROR');
  });
});

describe('pairing from the tenancy aggregate', () => {
  it('pairs move-in and move-out by pairIndex, in order', () => {
    const roomId = demoTenancy.rooms[0]!.roomId;
    const { before, after } = pairsForRoom(demoTenancy.photos, roomId);
    expect(before.map((p) => p.pairIndex)).toEqual([0, 1]);
    expect(after.map((p) => p.pairIndex)).toEqual([0, 1]);
    expect(before.every((p) => p.phase === 'MOVEIN')).toBe(true);
    expect(after.every((p) => p.phase === 'MOVEOUT')).toBe(true);
  });

  it('keeps rooms in the order the tenant walked them', () => {
    const rooms = roomsFromAggregate(demoTenancy);
    expect(rooms.map((r) => r.roomLabel)).toEqual([
      'Living Room',
      'Kitchen',
      'Bedroom 1',
      'Bathroom 1',
    ]);
  });

  it('reports PENDING and no changes — it computes no diff and invents none', () => {
    for (const room of roomsFromAggregate(demoTenancy)) {
      expect(room.status).toBe('PENDING');
      expect(room.changes).toEqual([]);
      expect(room.reviewReason).toBeUndefined();
    }
  });

  it('still lists a room that has only one phase captured', () => {
    const oneSided: GetTenancyResponse = {
      ...demoTenancy,
      photos: demoTenancy.photos.filter((p) => p.phase === 'MOVEIN'),
    };
    const rooms = roomsFromAggregate(oneSided);
    expect(rooms).toHaveLength(4);
    expect(rooms[0]!.after).toEqual([]);
    expect(rooms[0]!.before.length).toBeGreaterThan(0);
  });

  it('prefers the diff endpoint whenever it returned rooms', () => {
    const fromDiff = roomsFromAggregate(demoTenancy).slice(0, 1);
    const resolved = resolveRooms(fromDiff, demoTenancy);
    expect(resolved.source).toBe('diff');
    expect(resolved.rooms).toHaveLength(1);
  });

  it('falls back to the aggregate only when the diff has no rooms', () => {
    const resolved = resolveRooms([], demoTenancy);
    expect(resolved.source).toBe('aggregate');
    expect(resolved.rooms).toHaveLength(4);
  });

  it('preserves a NEEDS_REVIEW room exactly as the backend returned it', () => {
    const needsReview = {
      ...roomsFromAggregate(demoTenancy)[0]!,
      status: 'NEEDS_REVIEW' as const,
      reviewReason: 'AI_DISABLED' as const,
    };
    const resolved = resolveRooms([needsReview], demoTenancy);
    expect(resolved.rooms[0]!.status).toBe('NEEDS_REVIEW');
    expect(resolved.rooms[0]!.reviewReason).toBe('AI_DISABLED');
  });
});

describe('backend error mapping', () => {
  function apiError(status: number, code: string) {
    return new ApiError({ type: 'about:blank', title: code, status, code } as never);
  }

  it('maps each contract code to copy a tenant can act on', () => {
    expect(toUserFacingError(apiError(409, 'INGEST_INCOMPLETE')).retryable).toBe(true);
    expect(toUserFacingError(apiError(409, 'PHASE_ALREADY_COMPLETE')).retryable).toBe(false);
    expect(toUserFacingError(apiError(422, 'EMPTY_ROOM')).title).toMatch(/no photographs/i);
    expect(toUserFacingError(apiError(422, 'UNKNOWN_STATE')).detail).toMatch(/karnataka/i);
  });

  it('does not let the UI distinguish NOT_FOUND from FORBIDDEN', () => {
    expect(toUserFacingError(apiError(404, 'NOT_FOUND')).detail).toBe(
      toUserFacingError(apiError(403, 'FORBIDDEN')).detail,
    );
  });

  it('treats a 401 as a dead session, which is the only thing it can be', () => {
    expect(toUserFacingError(apiError(401, 'FORBIDDEN')).requiresSignIn).toBe(true);
    expect(toUserFacingError(apiError(404, 'NOT_FOUND')).requiresSignIn).toBe(false);
  });

  it('says the evidence is unaffected when the server fails', () => {
    expect(toUserFacingError(apiError(500, 'INTERNAL')).detail).toMatch(/unaffected/i);
    expect(toUserFacingError(new NetworkError('offline')).detail).toMatch(/unaffected/i);
  });

  it('never suggests demo data as a fallback', () => {
    const codes = ['INTERNAL', 'NOT_FOUND', 'INGEST_INCOMPLETE', 'VALIDATION_FAILED'];
    for (const code of codes) {
      const copy = toUserFacingError(apiError(500, code));
      expect(`${copy.title} ${copy.detail}`.toLowerCase()).not.toContain('demo');
    }
  });

  it('routes an auth failure to the sign-in boundary', () => {
    const copy = toUserFacingError(new AuthError('NotAuthorizedException', 'no match'));
    expect(copy.requiresSignIn).toBe(true);
  });

  it('distinguishes an undeployed route from a missing tenancy', () => {
    // API Gateway answers an unregistered route with a bare 404.
    expect(isRouteNotDeployed(apiError(404, 'INTERNAL'))).toBe(true);
    // The handler's own 404 is problem+json with NOT_FOUND.
    expect(isRouteNotDeployed(apiError(404, 'NOT_FOUND'))).toBe(false);
    expect(isRouteNotDeployed(new NetworkError('offline'))).toBe(false);
  });
});

describe('auth session storage', () => {
  it('keeps tokens in memory and never touches localStorage', () => {
    const storage = new MemoryStorage();
    storage.setItem('idToken', 'abc');

    expect(storage.getItem('idToken')).toBe('abc');
    expect(globalThis.localStorage?.getItem('idToken') ?? null).toBeNull();
  });

  it('drops everything on clear, which sign-out calls', () => {
    const storage = new MemoryStorage();
    storage.setItem('a', '1');
    storage.setItem('b', '2');
    storage.clear();
    expect(storage.size).toBe(0);
  });

  it('returns null for an unknown key, as the library expects', () => {
    expect(new MemoryStorage().getItem('nope')).toBeNull();
  });
});

describe('pairIndex matching (regression)', () => {
  const photo = (
    phase: 'MOVEIN' | 'MOVEOUT',
    pairIndex: number,
    roomId = 'rm_1',
  ): PhotoRef => ({
    photoId: `ph_${phase}_${pairIndex}`,
    roomId,
    phase,
    pairIndex,
    sha256: 'a'.repeat(64),
    bytes: 1000,
    receivedAt: '2026-09-15T10:00:00.000Z',
    url: `https://example.invalid/${phase}-${pairIndex}.jpg`,
    urlExpiresAt: '2099-01-01T00:00:00.000Z',
  });

  it('joins only on a shared pairIndex', () => {
    const pairs = matchedPairs(
      [photo('MOVEIN', 0), photo('MOVEIN', 1)],
      [photo('MOVEOUT', 0), photo('MOVEOUT', 1)],
    );
    expect(pairs.map((p) => p.pairIndex)).toEqual([0, 1]);
    for (const pair of pairs) {
      expect(pair.before.pairIndex).toBe(pair.after.pairIndex);
    }
  });

  it('never compares pairIndex 0 against pairIndex 1 when move-in 0 is missing', () => {
    // before: [1]  after: [0, 1]  — the bug paired before[0](=1) with after[0](=0).
    const pairs = matchedPairs([photo('MOVEIN', 1)], [photo('MOVEOUT', 0), photo('MOVEOUT', 1)]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.pairIndex).toBe(1);
    expect(pairs[0]!.before.pairIndex).toBe(1);
    expect(pairs[0]!.after.pairIndex).toBe(1);
  });

  it('never compares pairIndex 0 against pairIndex 1 when move-out 0 is missing', () => {
    const pairs = matchedPairs([photo('MOVEIN', 0), photo('MOVEIN', 1)], [photo('MOVEOUT', 1)]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.pairIndex).toBe(1);
  });

  it('yields no pair at all when the two sides share no index', () => {
    const pairs = matchedPairs([photo('MOVEIN', 0)], [photo('MOVEOUT', 1)]);
    expect(pairs).toEqual([]);
    expect(firstMatchedPair({ before: [photo('MOVEIN', 0)], after: [photo('MOVEOUT', 1)] })).toBeUndefined();
  });

  it('picks the lowest shared index, not the lowest index on either side', () => {
    const pair = firstMatchedPair({
      before: [photo('MOVEIN', 0), photo('MOVEIN', 2)],
      after: [photo('MOVEOUT', 1), photo('MOVEOUT', 2)],
    });
    expect(pair?.pairIndex).toBe(2);
  });

  it('matches regardless of the order the photos arrive in', () => {
    const pairs = matchedPairs(
      [photo('MOVEIN', 2), photo('MOVEIN', 0)],
      [photo('MOVEOUT', 0), photo('MOVEOUT', 2)],
    );
    expect(pairs.map((p) => p.pairIndex)).toEqual([0, 2]);
  });

  it('drops an unmatched index rather than pairing it with a neighbour', () => {
    const pairs = matchedPairs(
      [photo('MOVEIN', 0), photo('MOVEIN', 5)],
      [photo('MOVEOUT', 0)],
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.pairIndex).toBe(0);
  });

  it('reports why there is no comparison, so the UI can say which case it is', () => {
    expect(missingPairReason({ before: [], after: [] })).toBe('NO_PHOTOS');
    expect(missingPairReason({ before: [photo('MOVEIN', 0)], after: [] })).toBe('NO_AFTER');
    expect(missingPairReason({ before: [], after: [photo('MOVEOUT', 0)] })).toBe('NO_BEFORE');
    expect(
      missingPairReason({ before: [photo('MOVEIN', 0)], after: [photo('MOVEOUT', 1)] }),
    ).toBe('NO_SHARED_PAIR_INDEX');
  });

  it('reports no reason at all when a genuine pair exists', () => {
    expect(
      missingPairReason({ before: [photo('MOVEIN', 0)], after: [photo('MOVEOUT', 0)] }),
    ).toBeUndefined();
  });

  it('applies to rooms rebuilt from the aggregate too', () => {
    const rooms = roomsFromAggregate(demoTenancy);
    for (const room of rooms) {
      for (const pair of matchedPairs(room.before, room.after)) {
        expect(pair.before.pairIndex).toBe(pair.after.pairIndex);
      }
    }
  });
});
