import { afterEach, describe, expect, it, vi } from 'vitest';
import { toPaise } from '@handover/shared';
import { ApiError, NetworkError } from './api-client.js';
import { HttpApiClient } from './http-api-client.js';

const BASE = 'https://d5vqb4s6s3.execute-api.ap-south-1.amazonaws.com';

afterEach(() => vi.restoreAllMocks());

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl as unknown as typeof fetch);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problem(status: number, code: string): Response {
  return new Response(
    JSON.stringify({ type: 'about:blank', title: code, status, code }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

const TENANCY_RESPONSE = {
  tenancyId: 'tn_1',
  status: 'MOVEIN_PENDING',
  rooms: [{ roomId: 'rm_1', label: 'Living Room' }],
};

describe('HttpApiClient — auth header', () => {
  it('sends the Cognito ID token as a Bearer credential', async () => {
    const spy = mockFetch(async () => json(TENANCY_RESPONSE));
    const api = new HttpApiClient({
      baseUrl: BASE,
      getIdToken: async () => 'id-token-abc',
    });

    await api.getTenancy('tn_1').catch(() => undefined);

    const init = spy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer id-token-abc');
  });

  it('omits the header entirely when nobody is signed in', async () => {
    const spy = mockFetch(async () => problem(401, 'FORBIDDEN'));
    const api = new HttpApiClient({ baseUrl: BASE });

    await api.getTenancy('tn_1').catch(() => undefined);

    const init = spy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('asks for a token on every request, so a refresh is picked up', async () => {
    const tokens = ['first', 'second'];
    const spy = mockFetch(async () => json({ tenancyId: 'tn_1', rooms: [], needsReviewCount: 0 }));
    const api = new HttpApiClient({
      baseUrl: BASE,
      getIdToken: async () => tokens.shift(),
    });

    await api.getDiff('tn_1').catch(() => undefined);
    await api.getDiff('tn_1').catch(() => undefined);

    const auth = spy.mock.calls.map(
      (c) => ((c[1] as RequestInit).headers as Record<string, string>)['Authorization'],
    );
    expect(auth).toEqual(['Bearer first', 'Bearer second']);
  });
});

describe('HttpApiClient — request shape', () => {
  it('builds the documented paths against the configured base URL', async () => {
    const spy = mockFetch(async () => json(TENANCY_RESPONSE));
    const api = new HttpApiClient({ baseUrl: BASE });

    await api.getTenancy('tn_1').catch(() => undefined);
    expect(spy.mock.calls[0]![0]).toBe(`${BASE}/v1/tenancies/tn_1`);
  });

  it('encodes a path parameter rather than interpolating it raw', async () => {
    const spy = mockFetch(async () => json(TENANCY_RESPONSE));
    const api = new HttpApiClient({ baseUrl: BASE });

    await api.getTenancy('tn/../evil').catch(() => undefined);
    expect(spy.mock.calls[0]![0]).toBe(`${BASE}/v1/tenancies/tn%2F..%2Fevil`);
  });

  it('never sends ownerSub — §7 sets it from token claims, and bodies are strict', async () => {
    const spy = mockFetch(async () => json(TENANCY_RESPONSE, 201));
    const api = new HttpApiClient({ baseUrl: BASE, getIdToken: async () => 'tok' });

    await api
      .createTenancy({
        addressLine: '12 Ashwin Road',
        city: 'Bengaluru',
        stateCode: 'KA',
        monthlyRentPaise: toPaise(4_500_000),
        depositPaise: toPaise(20_000_000),
        moveInDate: '2026-01-15',
        landlordEmail: 'landlord@example.com',
        rooms: [{ label: 'Living Room', orderIndex: 0 }],
      })
      .catch(() => undefined);

    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('ownerSub');
    expect(body.stateCode).toBe('KA');
  });

  it('validates the response against the frozen schema', async () => {
    mockFetch(async () => json({ tenancyId: 'tn_1', status: 'WRONG', rooms: [] }, 201));
    const api = new HttpApiClient({ baseUrl: BASE });

    await expect(
      api.createTenancy({
        addressLine: 'a',
        city: 'b',
        stateCode: 'KA',
        monthlyRentPaise: toPaise(1),
        depositPaise: toPaise(1),
        moveInDate: '2026-01-15',
        landlordEmail: 'l@example.com',
        rooms: [{ label: 'R', orderIndex: 0 }],
      }),
    ).rejects.toThrow();
  });
});

describe('HttpApiClient — error mapping', () => {
  it('surfaces a problem+json code as an ApiError', async () => {
    mockFetch(async () => problem(409, 'INGEST_INCOMPLETE'));
    const api = new HttpApiClient({ baseUrl: BASE });

    await expect(api.getTenancy('tn_1')).rejects.toBeInstanceOf(ApiError);
    await expect(api.getTenancy('tn_1')).rejects.toMatchObject({ code: 'INGEST_INCOMPLETE' });
  });

  it('turns API Gateway’s bare 404 into a synthetic INTERNAL problem', async () => {
    // An unregistered route answers {"message":"Not Found"} — not problem+json.
    mockFetch(
      async () =>
        new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const api = new HttpApiClient({ baseUrl: BASE });

    await expect(api.getTenancy('tn_1')).rejects.toMatchObject({
      code: 'INTERNAL',
      problem: { status: 404 },
    });
  });

  it('reports a transport failure as NetworkError, not as an API error', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const api = new HttpApiClient({ baseUrl: BASE });

    await expect(api.getTenancy('tn_1')).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('HttpApiClient — presigned POST upload (web-contract §5 Leg 2)', () => {
  const upload = {
    clientRef: 'ref-1',
    url: 'https://evidence-bucket.s3.ap-south-1.amazonaws.com/',
    fields: {
      key: 'tenancies/tn_1/MOVEIN/rm_1/ph_1.jpg',
      'Content-Type': 'image/jpeg',
      bucket: 'evidence-bucket',
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      Policy: 'base64policy',
      'X-Amz-Signature': 'deadbeef',
    },
    s3Key: 'tenancies/tn_1/MOVEIN/rm_1/ph_1.jpg',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const blob = new Blob([new Uint8Array(1024)], { type: 'image/jpeg' });

  it('POSTs to the presigned URL exactly as returned', async () => {
    const spy = mockFetch(async () => new Response(null, { status: 204 }));
    const api = new HttpApiClient({ baseUrl: BASE, getIdToken: async () => 'tok' });

    await api.uploadPhoto(upload, blob);

    expect(spy.mock.calls[0]![0]).toBe(upload.url);
    expect((spy.mock.calls[0]![1] as RequestInit).method).toBe('POST');
  });

  it('appends every policy field first, in order, then the file last', async () => {
    const spy = mockFetch(async () => new Response(null, { status: 204 }));
    const api = new HttpApiClient({ baseUrl: BASE });

    await api.uploadPhoto(upload, blob);

    const form = (spy.mock.calls[0]![1] as RequestInit).body as FormData;
    expect([...form.keys()]).toEqual([...Object.keys(upload.fields), 'file']);
  });

  it('sends the key the backend chose — the client never invents an S3 path', async () => {
    const spy = mockFetch(async () => new Response(null, { status: 204 }));
    const api = new HttpApiClient({ baseUrl: BASE });

    await api.uploadPhoto(upload, blob);

    const form = (spy.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(form.get('key')).toBe(upload.s3Key);
  });

  it('sends the exact blob, unaltered — the policy pins content-length to it', async () => {
    const spy = mockFetch(async () => new Response(null, { status: 204 }));
    const api = new HttpApiClient({ baseUrl: BASE });

    await api.uploadPhoto(upload, blob);

    const form = (spy.mock.calls[0]![1] as RequestInit).body as FormData;
    const sent = form.get('file') as Blob;
    expect(sent.size).toBe(blob.size);
    expect(sent.type).toBe('image/jpeg');
  });

  it('sets no Content-Type header — the browser must own the multipart boundary', async () => {
    const spy = mockFetch(async () => new Response(null, { status: 204 }));
    const api = new HttpApiClient({ baseUrl: BASE });

    await api.uploadPhoto(upload, blob);

    expect((spy.mock.calls[0]![1] as RequestInit).headers).toBeUndefined();
  });

  it('sends no Authorization header — the signature is in the form', async () => {
    const spy = mockFetch(async () => new Response(null, { status: 204 }));
    const api = new HttpApiClient({ baseUrl: BASE, getIdToken: async () => 'id-token-abc' });

    await api.uploadPhoto(upload, blob);

    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(JSON.stringify(init.headers ?? {})).not.toContain('id-token-abc');
  });

  it('treats 204 as success and anything else as failure', async () => {
    mockFetch(async () => new Response(null, { status: 204 }));
    const api = new HttpApiClient({ baseUrl: BASE });
    await expect(api.uploadPhoto(upload, blob)).resolves.toBeUndefined();

    // S3 reports refusals as XML, so the status is what gets surfaced.
    mockFetch(async () => new Response('<Error><Code>EntityTooLarge</Code></Error>', { status: 400 }));
    const api2 = new HttpApiClient({ baseUrl: BASE });
    await expect(api2.uploadPhoto(upload, blob)).rejects.toBeInstanceOf(NetworkError);
  });

  it('does not treat a 200 as success — S3 POST success is 204', async () => {
    mockFetch(async () => new Response(null, { status: 200 }));
    const api = new HttpApiClient({ baseUrl: BASE });
    await expect(api.uploadPhoto(upload, blob)).rejects.toBeInstanceOf(NetworkError);
  });
});
