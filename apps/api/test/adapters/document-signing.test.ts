import { S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signDocumentGets } from '../../src/adapters/s3/document-writer.js';
import { resetS3Client } from '../../src/adapters/s3/presigner.js';

/**
 * §7, §10.1, and the asymmetry between the two buckets.
 *
 * `signEvidenceGets` refuses the whole request when a photograph will not
 * sign, because a missing photograph is a hole in the record and a payload
 * that quietly renders three of four is a tenant shown a short record with
 * nothing anywhere disagreeing. A generated document is different — it can be
 * rebuilt from the ledger — so `documentRefSchema.url` is optional and a key
 * that will not sign is simply absent.
 *
 * "Absent" must not mean "unnoticed". A document nobody can download is still
 * an operational fact, and this pins that it reaches the log rather than being
 * swallowed by a bare `catch {}`.
 */

const signing = vi.hoisted(() => ({ fail: false }));

vi.mock('@aws-sdk/s3-request-presigner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/s3-request-presigner')>();
  return {
    ...actual,
    getSignedUrl: async (...args: Parameters<typeof actual.getSignedUrl>): Promise<string> => {
      if (signing.fail) throw new Error('CredentialsProviderError');
      return actual.getSignedUrl(...args);
    },
  };
});

mockClient(S3Client);

const NOW = new Date('2026-10-15T12:00:00.000Z');
const KEY = 'tenancies/t_1/documents/DEMAND_LETTER/d_1.pdf';

beforeEach(() => {
  resetS3Client();
  signing.fail = false;
  process.env['DOCUMENTS_BUCKET'] = 'handover-documents-test';
  process.env['AWS_REGION'] = 'ap-south-1';
  process.env['AWS_ACCESS_KEY_ID'] = 'AKIAIOSFODNN7EXAMPLE';
  process.env['AWS_SECRET_ACCESS_KEY'] = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['DOCUMENTS_BUCKET'];
  delete process.env['AWS_ACCESS_KEY_ID'];
  delete process.env['AWS_SECRET_ACCESS_KEY'];
});

describe('signDocumentGets', () => {
  it('signs a document key', async () => {
    const signed = await signDocumentGets([KEY], NOW);
    expect(signed.get(KEY)?.url).toMatch(/X-Amz-Signature=/);
    expect(signed.get(KEY)?.expiresAt).toBe('2026-10-15T12:05:00.000Z');
  });

  it('omits a key it cannot sign rather than failing the whole read', async () => {
    signing.fail = true;
    expect((await signDocumentGets([KEY], NOW)).size).toBe(0);
  });

  it('reports the failure to the log instead of swallowing it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    signing.fail = true;

    await signDocumentGets([KEY], NOW);

    expect(error).toHaveBeenCalledWith('document_unsignable', expect.any(Object));
  });

  it('never puts the key itself in the log line — a key carries the tenancy id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    signing.fail = true;

    await signDocumentGets([KEY], NOW);

    expect(JSON.stringify(error.mock.calls)).not.toContain('t_1');
  });
});
