/**
 * Throwaway smoke test: send two photographs of the same room to a Bedrock
 * vision model in ONE message and print the raw response.
 *
 * Not part of the diff eval (§9.5) and not wired into any pnpm script. It
 * exists to answer one question before the diff-worker is built: does a
 * multi-image call in ap-south-1 return anything usable at all?
 *
 *   BEDROCK_API_KEY=... tsx smoke-two-image.ts <before.jpg> <after.jpg> <modelId>
 *
 * Talks to the bedrock-mantle endpoint's OpenAI-compatible Chat Completions
 * API over plain HTTP, because bedrock-runtime is not authorised on this
 * account. Deliberately has no dependencies -- no AWS SDK, no openai package,
 * just fetch -- so the eval package's manifest does not have to change.
 *
 * Nothing here is parsed or validated. Parsing belongs in the diff-worker,
 * behind the Zod result schema.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

/** https://bedrock-mantle.{region}.api.aws/v1/chat/completions */
const BASE_URL =
  process.env.BEDROCK_BASE_URL ?? 'https://bedrock-mantle.ap-south-1.api.aws/v1';

const PROMPT =
  'These are two photographs of the same room, before and after a tenancy. ' +
  'Ignore lighting, shadows, exposure, camera angle and distance, and the ' +
  'presence or absence of furniture and personal belongings. Report only ' +
  'changes to the fixed condition: walls, floor, ceiling, fittings, fixtures, ' +
  'doors, windows. Respond with only JSON, no other text: ' +
  '{"changes":[{"surface":"","description":"","confidence":0.0}]}';

/** MIME type for the data: URL. Chat Completions takes jpeg/png/gif/webp. */
function mimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      throw new Error(`unsupported image extension: ${ext || path}`);
  }
}

/**
 * Chat Completions carries images as an image_url part whose url is a base64
 * data URL. Unlike Converse's ImageBlock, the base64 is genuinely ours to
 * produce -- there is no SDK serializer doing it for us.
 */
async function loadImage(path: string) {
  const buf = await readFile(path);
  const mime = mimeType(path);
  const base64 = buf.toString('base64');

  console.error(
    `[smoke] ${path}: ${buf.byteLength} bytes raw, ${base64.length} chars base64, ${mime}`,
  );

  return { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } };
}

async function main() {
  const [beforePath, afterPath, modelId] = process.argv.slice(2);

  if (!beforePath || !afterPath || !modelId) {
    console.error('usage: tsx smoke-two-image.ts <before> <after> <modelId>');
    process.exit(2);
  }

  const apiKey = process.env.BEDROCK_API_KEY;
  if (!apiKey) {
    console.error('BEDROCK_API_KEY is not set (Bedrock API key for bedrock-mantle)');
    process.exit(2);
  }

  const [before, after] = await Promise.all([
    loadImage(beforePath),
    loadImage(afterPath),
  ]);

  // Both images and the prompt go in a single user message: one content array,
  // two image parts, one text part last.
  const body = {
    model: modelId,
    messages: [{ role: 'user', content: [before, after, { type: 'text', text: PROMPT }] }],
    max_tokens: 2048,
    temperature: 0,
  };

  const url = `${BASE_URL}/chat/completions`;
  console.error(`[smoke] POST ${url} -> ${modelId}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  console.error(`[smoke] HTTP ${response.status} ${response.statusText}`);

  // Raw dump. No parsing, no extraction, no validation.
  console.log(await response.text());

  if (!response.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
