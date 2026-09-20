/**
 * `RoomDiffPort` over the bedrock-mantle Chat Completions endpoint —
 * architecture.md §9.1, §9.5, §9.7.
 *
 * **This adapter is provisional.** `bedrock-runtime` is unauthorised on this
 * account (`InvokeModel` and `Converse` both return `AccessDeniedException`;
 * an AWS support case is open), so the working path is the OpenAI-compatible
 * Chat Completions API at `https://bedrock-mantle.<region>.api.aws/v1`, over
 * plain HTTP with a bearer token. When the support case clears, a sibling
 * adapter implements the same port against Converse with tool use and the
 * swap is an SSM value — no domain change, no test change (§9.1).
 *
 * Everything model-shaped stops here. The adapter transports bytes and
 * returns parsed responses; it does not decide what is true. The decision of
 * which changes survive belongs to `domain/diff/merge.ts` and this file must
 * never shortcut it.
 *
 * Logging discipline (§9.7): model id, prompt version, token counts, cached
 * tokens, latency and per-run parse outcome. **Never images, never prompt
 * text, never the API key, never model-written descriptions.**
 */

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { mergeSelfConsistent, MERGE_DEFAULTS } from '../../domain/diff/merge.js';
import { parseModelResponse, type WireDiffResult } from '../../domain/diff/parse.js';
import type {
  DiffImage,
  RoomDiffOutcome,
  RoomDiffPort,
  RoomDiffRequest,
} from '../../domain/diff/port.js';
import { roomDiffPrompt, isPromptVersion } from '../../prompts/registry.js';

/* ------------------------------------------------------------------ */
/* Injected seams                                                      */
/* ------------------------------------------------------------------ */

/**
 * The HTTP surface, narrowed to what this adapter uses. Declared rather than
 * reaching for `fetch`'s types directly so the unit tests can supply a plain
 * object and so nothing DOM-shaped leaks into the build.
 */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type HttpPost = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<HttpResponseLike>;

export interface LogFields {
  readonly [key: string]: string | number | boolean | undefined;
}

export interface Logger {
  info(event: string, fields: LogFields): void;
  warn(event: string, fields: LogFields): void;
}

const defaultLogger: Logger = {
  info: (event, fields) => console.log(JSON.stringify({ level: 'INFO', event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ level: 'WARN', event, ...fields })),
};

const defaultHttpPost: HttpPost = (url, init) => fetch(url, init);

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export const MODEL_ID_PARAMETER = '/handover/dev/bedrock/model-id';
export const API_KEY_SECRET_ID = '/handover/dev/bedrock/api-key';
const DEFAULT_BASE_URL = 'https://bedrock-mantle.ap-south-1.api.aws/v1';

export interface MantleRoomDiffConfig {
  readonly httpPost?: HttpPost;
  readonly logger?: Logger;
  readonly ssm?: SSMClient;
  readonly secrets?: SecretsManagerClient;
  readonly baseUrl?: string;
  readonly env?: Record<string, string | undefined>;
  /** Default N. Overridden per request. */
  readonly sampleCount?: number;
  readonly minAgreement?: number;
  /** Retry budget for throttling and transport errors, per sample. */
  readonly maxTransportAttempts?: number;
  /** Injectable so tests do not sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable so backoff jitter is deterministic under test. */
  readonly random?: () => number;
}

export class NotConfiguredError extends Error {}

/**
 * Model id: SSM, with an env override for local runs. The override exists so
 * the eval harness and a laptop can point at a different model without an AWS
 * round trip; in Lambda the parameter is the source of truth.
 */
async function resolveModelId(
  env: Record<string, string | undefined>,
  ssm: () => SSMClient,
): Promise<string> {
  const override = env['BEDROCK_MODEL_ID'];
  if (override !== undefined && override.trim() !== '') return override.trim();

  const name = env['BEDROCK_MODEL_ID_PARAMETER'] ?? MODEL_ID_PARAMETER;
  const result = await ssm().send(new GetParameterCommand({ Name: name }));
  const value = result.Parameter?.Value?.trim();
  if (value === undefined || value === '') {
    throw new NotConfiguredError(`SSM parameter ${name} is empty or absent`);
  }
  return value;
}

/**
 * API key: Secrets Manager, with an env override for local runs. Never read
 * from the repository, never written to a log, never included in an error
 * message — which is why the catch below re-throws a message of its own
 * rather than the SDK's.
 */
async function resolveApiKey(
  env: Record<string, string | undefined>,
  secrets: () => SecretsManagerClient,
): Promise<string> {
  const override = env['BEDROCK_API_KEY'];
  if (override !== undefined && override.trim() !== '') return override.trim();

  const secretId = env['BEDROCK_API_KEY_SECRET_ID'] ?? API_KEY_SECRET_ID;
  const result = await secrets().send(new GetSecretValueCommand({ SecretId: secretId }));
  const value = result.SecretString?.trim();
  if (value === undefined || value === '') {
    throw new NotConfiguredError(`secret ${secretId} is empty or absent`);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Wire shapes                                                         */
/* ------------------------------------------------------------------ */

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: ChatUsage;
}

/** Chat Completions carries an image as a base64 data URL, not a binary part. */
function imagePart(image: DiffImage) {
  const base64 = Buffer.from(image.bytes).toString('base64');
  return { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${base64}` } };
}

/**
 * One user message: `[image_url, image_url, text]`. This exact ordering is
 * what the smoke test proved works against this endpoint — both images first,
 * the instruction last.
 */
function requestBody(model: string, before: DiffImage, after: DiffImage, prompt: string) {
  return {
    model,
    messages: [
      {
        role: 'user',
        content: [imagePart(before), imagePart(after), { type: 'text', text: prompt }],
      },
    ],
    max_tokens: 2048,
    // Kept at 0 for honesty about intent, not because it helps: four identical
    // calls at 0 returned four different answers (§9.5). The N-sampling merge
    // is what actually buys stability.
    temperature: 0,
  };
}

function contentOf(payload: ChatCompletion): string | undefined {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  // Some deployments return the content as parts rather than a string.
  if (Array.isArray(content)) {
    const joined = content
      .map((part) =>
        typeof part === 'object' && part !== null && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join('');
    return joined === '' ? undefined : joined;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* The adapter                                                         */
/* ------------------------------------------------------------------ */

interface SampleSuccess {
  readonly ok: true;
  readonly value: WireDiffResult;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens: number;
  readonly latencyMs: number;
  readonly repaired: boolean;
}

interface SampleFailure {
  readonly ok: false;
  readonly kind: 'PARSE_FAILED' | 'MODEL_ERROR' | 'THROTTLED';
  readonly detail: string;
  readonly latencyMs: number;
}

type SampleResult = SampleSuccess | SampleFailure;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class MantleRoomDiffAdapter implements RoomDiffPort {
  readonly #config: MantleRoomDiffConfig;
  readonly #httpPost: HttpPost;
  readonly #logger: Logger;
  readonly #env: Record<string, string | undefined>;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  #ssm: SSMClient | undefined;
  #secrets: SecretsManagerClient | undefined;
  /** Resolved once per container. Config reads are not per-invocation work. */
  #credentials: Promise<{ modelId: string; apiKey: string }> | undefined;

  constructor(config: MantleRoomDiffConfig = {}) {
    this.#config = config;
    this.#httpPost = config.httpPost ?? defaultHttpPost;
    this.#logger = config.logger ?? defaultLogger;
    this.#env = config.env ?? process.env;
    this.#sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = config.random ?? Math.random;
    this.#ssm = config.ssm;
    this.#secrets = config.secrets;
  }

  async diffRoom(request: RoomDiffRequest): Promise<RoomDiffOutcome> {
    const sampleCount =
      request.sampleCount ?? this.#config.sampleCount ?? MERGE_DEFAULTS.sampleCount;
    const minAgreement = this.#config.minAgreement ?? MERGE_DEFAULTS.minAgreement;

    if (!isPromptVersion(request.promptVersion)) {
      return this.#fail('NOT_CONFIGURED', `unregistered promptVersion`, 0);
    }
    const prompt = roomDiffPrompt(request.promptVersion);

    let modelId: string;
    let apiKey: string;
    try {
      ({ modelId, apiKey } = await this.#resolveCredentials());
    } catch (error) {
      return this.#fail(
        'NOT_CONFIGURED',
        error instanceof NotConfiguredError ? error.message : 'configuration unavailable',
        0,
      );
    }

    const body = JSON.stringify(
      requestBody(modelId, request.before, request.after, prompt),
    );
    const startedAt = Date.now();

    // Samples run concurrently. Sequentially, N=5 at ~20s a call would put a
    // six-room job past the Lambda timeout; §15.2's budget assumes one call's
    // latency per room, and this is how that stays true.
    const samples = await Promise.all(
      Array.from({ length: sampleCount }, (_, index) =>
        this.#sample({ body, apiKey, modelId, request, index }),
      ),
    );

    const successes = samples.filter((s): s is SampleSuccess => s.ok);
    const totalLatencyMs = Date.now() - startedAt;

    this.#logger.info('diff.room.sampled', {
      jobId: request.jobId,
      modelId,
      promptVersion: request.promptVersion,
      requestedSamples: sampleCount,
      parsedSamples: successes.length,
      repairedSamples: successes.filter((s) => s.repaired).length,
      promptTokens: successes.reduce((sum, s) => sum + s.promptTokens, 0),
      completionTokens: successes.reduce((sum, s) => sum + s.completionTokens, 0),
      cachedPromptTokens: successes.reduce((sum, s) => sum + s.cachedTokens, 0),
      latencyMs: totalLatencyMs,
    });

    if (successes.length === 0) {
      const throttled = samples.every((s) => !s.ok && s.kind === 'THROTTLED');
      const kind = throttled ? 'THROTTLED' : (samples[0] as SampleFailure | undefined)?.kind;
      return this.#fail(
        kind === 'MODEL_ERROR' || kind === 'THROTTLED' ? kind : 'PARSE_FAILED',
        'no sample produced a valid change list',
        sampleCount,
      );
    }

    // Fewer usable samples than the agreement bar means the bar cannot be met
    // by any change. Reporting "no changes found" here would be a lie about
    // the reason, so the room goes to NEEDS_REVIEW instead (§9.6).
    if (successes.length < minAgreement) {
      return this.#fail(
        'PARSE_FAILED',
        `only ${successes.length} of ${sampleCount} samples parsed; agreement bar is ${minAgreement}`,
        sampleCount,
      );
    }

    const merged = mergeSelfConsistent(
      successes.map((s) => s.value),
      { minAgreement },
    );

    this.#logger.info('diff.room.merged', {
      jobId: request.jobId,
      modelId,
      promptVersion: request.promptVersion,
      sampleCount: merged.sampleCount,
      minAgreement: merged.minAgreement,
      survivingChanges: merged.changes.length,
      droppedClusters: merged.dropped.length,
    });

    return { ok: true, value: merged, modelId };
  }

  #fail(
    kind: 'PARSE_FAILED' | 'MODEL_ERROR' | 'THROTTLED' | 'NOT_CONFIGURED' | 'DISABLED',
    message: string,
    attempted: number,
  ): RoomDiffOutcome {
    this.#logger.warn('diff.room.failed', { kind, message, attempted });
    return { ok: false, failure: { kind, message, attempted } };
  }

  async #resolveCredentials(): Promise<{ modelId: string; apiKey: string }> {
    this.#credentials ??= (async () => {
      const [modelId, apiKey] = await Promise.all([
        resolveModelId(this.#env, () => (this.#ssm ??= new SSMClient({}))),
        resolveApiKey(this.#env, () => (this.#secrets ??= new SecretsManagerClient({}))),
      ]);
      return { modelId, apiKey };
    })();

    try {
      return await this.#credentials;
    } catch (error) {
      // Do not cache a failure: a missing parameter may be added without a
      // redeploy, and a cached rejection would outlive the fix.
      this.#credentials = undefined;
      throw error;
    }
  }

  /** One sample: call, parse, and on a parse failure retry exactly once (§9.3). */
  async #sample(args: {
    body: string;
    apiKey: string;
    modelId: string;
    request: RoomDiffRequest;
    index: number;
  }): Promise<SampleResult> {
    const startedAt = Date.now();
    const first = await this.#callAndParse(args);
    if (first.ok) {
      this.#log(args, first, 'PARSED', false);
      return first;
    }

    if (first.kind !== 'PARSE_FAILED') {
      this.#log(args, first, first.kind, false);
      return first;
    }

    // Exactly one repair retry. Never a third attempt, never a hand-patched
    // object — the room goes to NEEDS_REVIEW instead (§9.3).
    const retry = await this.#callAndParse(args);
    const repaired: SampleResult = retry.ok
      ? { ...retry, repaired: true, latencyMs: Date.now() - startedAt }
      : retry;
    this.#log(args, repaired, repaired.ok ? 'PARSED_ON_RETRY' : 'PARSE_FAILED_TWICE', true);
    return repaired;
  }

  #log(
    args: { request: RoomDiffRequest; modelId: string; index: number },
    result: SampleResult,
    outcome: string,
    wasRetried: boolean,
  ): void {
    this.#logger.info('diff.sample', {
      jobId: args.request.jobId,
      modelId: args.modelId,
      promptVersion: args.request.promptVersion,
      sampleIndex: args.index,
      outcome,
      wasRetried,
      latencyMs: result.latencyMs,
      promptTokens: result.ok ? result.promptTokens : undefined,
      completionTokens: result.ok ? result.completionTokens : undefined,
      cachedPromptTokens: result.ok ? result.cachedTokens : undefined,
      // `detail` is our own text or a status code, never model prose.
      detail: result.ok ? undefined : result.detail,
    });
  }

  async #callAndParse(args: {
    body: string;
    apiKey: string;
    modelId: string;
  }): Promise<SampleResult> {
    const startedAt = Date.now();
    const baseUrl = this.#config.baseUrl ?? this.#env['BEDROCK_BASE_URL'] ?? DEFAULT_BASE_URL;
    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const maxAttempts = this.#config.maxTransportAttempts ?? 3;

    let lastFailure: SampleFailure = {
      ok: false,
      kind: 'MODEL_ERROR',
      detail: 'no attempt made',
      latencyMs: 0,
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: HttpResponseLike;
      try {
        response = await this.#httpPost(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${args.apiKey}`,
          },
          body: args.body,
        });
      } catch (error) {
        lastFailure = {
          ok: false,
          kind: 'MODEL_ERROR',
          // The SDK/undici message can carry the URL but never the key.
          detail: error instanceof Error ? error.name : 'transport error',
          latencyMs: Date.now() - startedAt,
        };
        if (attempt < maxAttempts) {
          await this.#backoff(attempt);
          continue;
        }
        return lastFailure;
      }

      if (!response.ok) {
        const retryable = RETRYABLE_STATUS.has(response.status);
        lastFailure = {
          ok: false,
          kind: response.status === 429 ? 'THROTTLED' : 'MODEL_ERROR',
          detail: `HTTP ${response.status}`,
          latencyMs: Date.now() - startedAt,
        };
        if (retryable && attempt < maxAttempts) {
          await this.#backoff(attempt);
          continue;
        }
        return lastFailure;
      }

      const latencyMs = Date.now() - startedAt;
      let payload: ChatCompletion;
      try {
        payload = JSON.parse(await response.text()) as ChatCompletion;
      } catch {
        return { ok: false, kind: 'MODEL_ERROR', detail: 'envelope was not JSON', latencyMs };
      }

      const content = contentOf(payload);
      if (content === undefined) {
        return { ok: false, kind: 'MODEL_ERROR', detail: 'no message content', latencyMs };
      }

      const parsed = parseModelResponse(content);
      const usage = payload.usage ?? {};

      if (!parsed.ok) {
        return {
          ok: false,
          kind: 'PARSE_FAILED',
          detail: `${parsed.reason}: ${parsed.detail}`,
          latencyMs,
        };
      }

      return {
        ok: true,
        value: parsed.value,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        latencyMs,
        repaired: false,
      };
    }

    return lastFailure;
  }

  /** Exponential backoff with jitter, capped — never an unbounded retry (§11.3). */
  async #backoff(attempt: number): Promise<void> {
    const base = Math.min(2000, 200 * 2 ** (attempt - 1));
    await this.#sleep(Math.round(base * (0.5 + this.#random() * 0.5)));
  }
}
