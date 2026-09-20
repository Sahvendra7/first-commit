import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import {
  MantleRoomDiffAdapter,
  MODEL_ID_PARAMETER,
  API_KEY_SECRET_ID,
  type HttpPost,
  type LogFields,
  type Logger,
} from '../../../src/adapters/bedrock/mantle-room-diff.js';
import type { DiffImage } from '../../../src/domain/diff/port.js';

/**
 * No LocalStack (§13.2). SSM and Secrets Manager are `aws-sdk-client-mock`;
 * the endpoint itself is a plain injected function, because the thing under
 * test is how this adapter behaves when the endpoint misbehaves.
 */

const ssmMock = mockClient(SSMClient);
const secretsMock = mockClient(SecretsManagerClient);

const image = (byte: number): DiffImage => ({
  bytes: new Uint8Array([byte, byte, byte]),
  mediaType: 'image/jpeg',
});

const CHANGE = {
  type: 'STAIN',
  surface: 'FLOOR',
  location: 'floor near the doorway',
  description: 'A dark stain on the floor near the doorway, absent in the first photograph.',
  confidence: 0.7,
};

function completion(content: string, usage?: Record<string, unknown>) {
  return JSON.stringify({
    choices: [{ message: { content } }],
    usage: usage ?? {
      prompt_tokens: 2511,
      completion_tokens: 120,
      prompt_tokens_details: { cached_tokens: 2000 },
    },
  });
}

function okResponse(content: string, usage?: Record<string, unknown>) {
  return { ok: true, status: 200, text: async () => completion(content, usage) };
}

interface Recorded {
  event: string;
  fields: LogFields;
}

function recordingLogger(): { logger: Logger; entries: Recorded[] } {
  const entries: Recorded[] = [];
  return {
    entries,
    logger: {
      info: (event, fields) => entries.push({ event, fields }),
      warn: (event, fields) => entries.push({ event, fields }),
    },
  };
}

function adapterWith(httpPost: HttpPost, overrides = {}) {
  const { logger, entries } = recordingLogger();
  const adapter = new MantleRoomDiffAdapter({
    httpPost,
    logger,
    env: {},
    sleep: async () => {},
    random: () => 0.5,
    ...overrides,
  });
  return { adapter, entries };
}

const request = { before: image(1), after: image(2), promptVersion: 'v2' as const, jobId: 'job-1' };

beforeEach(() => {
  ssmMock.reset();
  secretsMock.reset();
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'moonshotai.kimi-k2.5' } });
  secretsMock.on(GetSecretValueCommand).resolves({ SecretString: 'sk-test-not-a-real-key' });
});

describe('MantleRoomDiffAdapter — configuration', () => {
  it('reads the model id from SSM and the key from Secrets Manager', async () => {
    const httpPost = vi.fn<HttpPost>(async () => okResponse(JSON.stringify({ changes: [] })));
    const { adapter } = adapterWith(httpPost);

    await adapter.diffRoom(request);

    expect(ssmMock.commandCalls(GetParameterCommand)[0]?.args[0].input).toMatchObject({
      Name: MODEL_ID_PARAMETER,
    });
    expect(secretsMock.commandCalls(GetSecretValueCommand)[0]?.args[0].input).toMatchObject({
      SecretId: API_KEY_SECRET_ID,
    });

    const [, init] = httpPost.mock.calls[0]!;
    expect(init.headers['Authorization']).toBe('Bearer sk-test-not-a-real-key');
    expect(JSON.parse(init.body).model).toBe('moonshotai.kimi-k2.5');
  });

  it('prefers the env overrides and makes no AWS call at all', async () => {
    const httpPost = vi.fn<HttpPost>(async () => okResponse(JSON.stringify({ changes: [] })));
    const { adapter } = adapterWith(httpPost, {
      env: { BEDROCK_MODEL_ID: 'local-model', BEDROCK_API_KEY: 'local-key' },
    });

    await adapter.diffRoom(request);

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(0);
    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(0);
    expect(JSON.parse(httpPost.mock.calls[0]![1].body).model).toBe('local-model');
  });

  it('fails NOT_CONFIGURED, not MODEL_ERROR, when the parameter is absent', async () => {
    ssmMock.on(GetParameterCommand).resolves({});
    const httpPost = vi.fn<HttpPost>(async () => okResponse('{"changes":[]}'));
    const { adapter } = adapterWith(httpPost);

    const out = await adapter.diffRoom(request);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('NOT_CONFIGURED');
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('rejects an unregistered prompt version before spending a token', async () => {
    const httpPost = vi.fn<HttpPost>(async () => okResponse('{"changes":[]}'));
    const { adapter } = adapterWith(httpPost);

    const out = await adapter.diffRoom({ ...request, promptVersion: 'v99' });

    expect(out.ok).toBe(false);
    expect(httpPost).not.toHaveBeenCalled();
  });
});

describe('MantleRoomDiffAdapter — request shape', () => {
  it('sends [image_url, image_url, text] in one user message', async () => {
    const httpPost = vi.fn<HttpPost>(async () => okResponse('{"changes":[]}'));
    const { adapter } = adapterWith(httpPost);

    await adapter.diffRoom(request);

    const body = JSON.parse(httpPost.mock.calls[0]![1].body);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content.map((p: { type: string }) => p.type)).toEqual([
      'image_url',
      'image_url',
      'text',
    ]);
    expect(body.messages[0].content[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(body.temperature).toBe(0);
  });

  it('samples N times for one pair', async () => {
    const httpPost = vi.fn<HttpPost>(async () => okResponse('{"changes":[]}'));
    const { adapter } = adapterWith(httpPost);

    await adapter.diffRoom({ ...request, sampleCount: 5 });

    expect(httpPost).toHaveBeenCalledTimes(5);
  });
});

describe('MantleRoomDiffAdapter — the merge is not optional', () => {
  it('drops a change only one of five samples reported', async () => {
    let call = 0;
    const httpPost = vi.fn<HttpPost>(async () => {
      call += 1;
      return okResponse(JSON.stringify({ changes: call === 1 ? [CHANGE] : [] }));
    });
    const { adapter } = adapterWith(httpPost);

    const out = await adapter.diffRoom({ ...request, sampleCount: 5 });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.changes).toEqual([]);
    expect(out.value.dropped).toHaveLength(1);
  });

  it('keeps a change four of five samples reported, with derived confidence', async () => {
    let call = 0;
    const httpPost = vi.fn<HttpPost>(async () => {
      call += 1;
      return okResponse(JSON.stringify({ changes: call === 5 ? [] : [CHANGE] }));
    });
    const { adapter } = adapterWith(httpPost);

    const out = await adapter.diffRoom({ ...request, sampleCount: 5 });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.changes).toHaveLength(1);
    expect(out.value.changes[0]?.agreementFrequency).toBeCloseTo(0.8);
  });
});

describe('MantleRoomDiffAdapter — broken output contracts', () => {
  it('parses a ```json-fenced response, which one run in four was', async () => {
    const httpPost = vi.fn<HttpPost>(
      async () => okResponse('\n\n```json\n' + JSON.stringify({ changes: [CHANGE] }) + '\n```\n'),
    );
    const { adapter } = adapterWith(httpPost);

    const out = await adapter.diffRoom({ ...request, sampleCount: 3 });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.changes).toHaveLength(1);
  });

  it('retries a malformed response exactly once, then succeeds', async () => {
    let call = 0;
    const httpPost = vi.fn<HttpPost>(async () => {
      call += 1;
      return okResponse(call === 1 ? 'I cannot compare these.' : JSON.stringify({ changes: [] }));
    });
    const { adapter, entries } = adapterWith(httpPost);

    const out = await adapter.diffRoom({ ...request, sampleCount: 1 });

    expect(httpPost).toHaveBeenCalledTimes(2);
    expect(out.ok).toBe(false); // 1 sample < minAgreement 3 — NEEDS_REVIEW, not "no changes"
    expect(entries.some((e) => e.fields['outcome'] === 'PARSED_ON_RETRY')).toBe(true);
  });

  it('never makes a third attempt at a sample that will not parse', async () => {
    const httpPost = vi.fn<HttpPost>(async () => okResponse('no JSON here, sorry'));
    const { adapter } = adapterWith(httpPost);

    const out = await adapter.diffRoom({ ...request, sampleCount: 2 });

    expect(httpPost).toHaveBeenCalledTimes(4); // 2 samples x (1 call + 1 repair retry)
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('PARSE_FAILED');
  });

  it('fails the room rather than merging fewer samples than the agreement bar', async () => {
    let call = 0;
    const httpPost = vi.fn<HttpPost>(async () => {
      call += 1;
      // Samples 1 and 2 parse; the rest never do.
      return okResponse(call <= 2 ? JSON.stringify({ changes: [CHANGE] }) : 'nope');
    });
    const { adapter } = adapterWith(httpPost);

    const out = await adapter.diffRoom({ ...request, sampleCount: 5 });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('PARSE_FAILED');
    expect(out.failure.message).toMatch(/agreement bar/);
  });
});

describe('MantleRoomDiffAdapter — transport failures', () => {
  it('reports THROTTLED after the capped retries on 429', async () => {
    const httpPost = vi.fn<HttpPost>(async () => ({
      ok: false,
      status: 429,
      text: async () => 'slow down',
    }));
    const { adapter } = adapterWith(httpPost);

    const out = await adapter.diffRoom({ ...request, sampleCount: 1 });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('THROTTLED');
    expect(httpPost).toHaveBeenCalledTimes(3); // capped, not infinite
  });

  it('does not retry a 400 — a bad request stays bad', async () => {
    const httpPost = vi.fn<HttpPost>(async () => ({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    }));
    const { adapter } = adapterWith(httpPost);

    const out = await adapter.diffRoom({ ...request, sampleCount: 1 });

    expect(httpPost).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('MODEL_ERROR');
  });

  it('survives a thrown transport error', async () => {
    const httpPost = vi.fn<HttpPost>(async () => {
      throw new TypeError('fetch failed');
    });
    const { adapter } = adapterWith(httpPost);

    const out = await adapter.diffRoom({ ...request, sampleCount: 1 });

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe('MODEL_ERROR');
  });
});

describe('MantleRoomDiffAdapter — logging discipline (§9.7)', () => {
  it('logs model id, prompt version, tokens, cache hits, latency and outcome', async () => {
    const httpPost = vi.fn<HttpPost>(async () => okResponse(JSON.stringify({ changes: [CHANGE] })));
    const { adapter, entries } = adapterWith(httpPost);

    await adapter.diffRoom({ ...request, sampleCount: 3 });

    const sample = entries.find((e) => e.event === 'diff.sample');
    expect(sample?.fields).toMatchObject({
      modelId: 'moonshotai.kimi-k2.5',
      promptVersion: 'v2',
      outcome: 'PARSED',
      promptTokens: 2511,
      cachedPromptTokens: 2000,
    });
    expect(typeof sample?.fields['latencyMs']).toBe('number');

    const room = entries.find((e) => e.event === 'diff.room.sampled');
    expect(room?.fields).toMatchObject({ requestedSamples: 3, parsedSamples: 3 });
    expect(room?.fields['promptTokens']).toBe(2511 * 3);
  });

  it('never logs the api key, the prompt, the images or model prose', async () => {
    const httpPost = vi.fn<HttpPost>(async () => okResponse(JSON.stringify({ changes: [CHANGE] })));
    const { adapter, entries } = adapterWith(httpPost);

    await adapter.diffRoom({ ...request, sampleCount: 3 });

    const dump = JSON.stringify(entries);
    expect(dump).not.toContain('sk-test-not-a-real-key');
    expect(dump).not.toContain('base64');
    expect(dump).not.toContain('out-of-frame'); // a phrase unique to the prompt
    expect(dump).not.toContain('dark stain'); // model prose
  });
});
