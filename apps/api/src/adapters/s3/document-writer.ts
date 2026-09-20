/**
 * Writing a generated document to S3 — architecture.md §5.6, §5.8, §7.
 *
 * The documents bucket is separate from the evidence bucket and is governed by
 * different rules, which is the whole reason it exists. Evidence is versioned
 * **and** delete-denied to every principal, because an uploaded photograph is
 * the thing the product's claim rests on. A generated PDF is a derivative: it
 * can be rebuilt from the ledger at any time, so it is versioned but not
 * delete-denied, and it is reachable only through a presigned GET of at most
 * five minutes (§7).
 *
 * The digest is computed here from the exact bytes that are written, not
 * recomputed later from a re-render. The document item's `sha256` therefore
 * attests to the stored object and to nothing else — the same property
 * `photo-ingest` gives an uploaded photograph.
 */
import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';
import { GET_URL_TTL_SECONDS } from '../../domain/evidence/aggregate.js';
import { s3Client } from './presigner.js';
import type { DocumentType } from '@handover/shared';
import type { ResolvedUrl } from '../../domain/evidence/aggregate.js';

/**
 * `tenancies/<tenancyId>/documents/<docType>/<documentId>.pdf`.
 *
 * Under the same `tenancies/` prefix the evidence objects use, so one IAM
 * statement per bucket covers a tenancy's objects, and the document type is in
 * the path so an operator reading a key knows what they are looking at without
 * a table lookup.
 */
export function documentKey(
  tenancyId: string,
  docType: DocumentType,
  documentId: string,
): string {
  return `tenancies/${tenancyId}/documents/${docType}/${documentId}.pdf`;
}

export interface StoredDocument {
  readonly s3Key: string;
  /** Digest of exactly the bytes written. */
  readonly sha256: string;
  readonly bytes: number;
}

export async function putDocumentObject(
  tenancyId: string,
  docType: DocumentType,
  documentId: string,
  pdf: Uint8Array,
): Promise<StoredDocument> {
  const s3Key = documentKey(tenancyId, docType, documentId);

  await s3Client().send(
    new PutObjectCommand({
      Bucket: config.documentsBucket(),
      Key: s3Key,
      Body: pdf,
      ContentType: 'application/pdf',
      // Inline so a presigned GET opens in the browser rather than downloading
      // a file the tenant then has to find.
      ContentDisposition: 'inline',
    }),
  );

  return {
    s3Key,
    sha256: createHash('sha256').update(pdf).digest('hex'),
    bytes: pdf.byteLength,
  };
}

/** A presigned GET for a generated document, 5 minutes (§7). */
export async function signDocumentGet(s3Key: string, now: Date): Promise<ResolvedUrl> {
  const url = await getSignedUrl(
    s3Client(),
    new GetObjectCommand({ Bucket: config.documentsBucket(), Key: s3Key }),
    { expiresIn: GET_URL_TTL_SECONDS },
  );
  return {
    url,
    expiresAt: new Date(now.getTime() + GET_URL_TTL_SECONDS * 1000).toISOString(),
  };
}

/**
 * Sign a batch of document keys.
 *
 * A key that will not sign is simply absent, and that is safe here in a way it
 * is not for evidence: `documentRefSchema.url` is optional, and a generated
 * PDF can be rebuilt from the ledger at any time. An unreadable *photograph*
 * is a hole in the record, which is why `signEvidenceGets` refuses to shrug at
 * one; an unreadable report is an inconvenience.
 *
 * Absent is not the same as unnoticed, though, so each failure is logged.
 */
export async function signDocumentGets(
  s3Keys: readonly string[],
  now: Date,
): Promise<Map<string, ResolvedUrl>> {
  const entries = await Promise.all(
    s3Keys.map(async (s3Key) => {
      try {
        return [s3Key, await signDocumentGet(s3Key, now)] as const;
      } catch (error) {
        // Absent, but not unnoticed. A document nobody can download is still an
        // operational fact, and a bare `catch {}` is how that fact disappears.
        // The key stays out of the line — it carries the tenancy id (§10.1) —
        // so the digest of it is what an operator correlates against.
        console.error('document_unsignable', {
          keyDigest: createHash('sha256').update(s3Key).digest('hex').slice(0, 12),
          error: (error as Error)?.name ?? 'unknown',
        });
        return undefined;
      }
    }),
  );
  return new Map(entries.filter((e): e is readonly [string, ResolvedUrl] => e !== undefined));
}
