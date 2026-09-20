import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_ROOT,
  InvalidEvidenceKeyError,
  buildEvidenceKey,
  extensionForContentType,
  parseEvidenceKey,
  tenancyUploadPrefix,
} from '../../../src/domain/evidence/object-key.js';

/**
 * The S3 object key is a trust boundary, not a naming convention.
 *
 * `photo-ingest` is triggered by an S3 event and learns which tenancy, phase
 * and room an object belongs to from its key alone — there is no other input.
 * So the key must be (a) built only here, (b) parseable back into exactly the
 * components that built it, and (c) impossible to forge across partitions.
 *
 * (c) is why every component is rejected if it contains `/` or `#`: a `roomId`
 * of `../other-tenancy` or `r1#META` would otherwise let a crafted upload write
 * a photo record into a partition its owner does not own.
 */

const base = {
  tenancyId: 't_abc123',
  phase: 'MOVEIN' as const,
  roomId: 'r_kitchen',
  photoId: 'p_0001',
  contentType: 'image/jpeg' as const,
};

describe('buildEvidenceKey', () => {
  it('lays the key out tenancy → phase → room → photo', () => {
    expect(buildEvidenceKey(base)).toBe(
      'tenancies/t_abc123/MOVEIN/r_kitchen/p_0001.jpg',
    );
  });

  it('roots every key under the single evidence prefix', () => {
    expect(buildEvidenceKey(base).startsWith(EVIDENCE_ROOT)).toBe(true);
  });

  it('maps each allowed content type to its extension', () => {
    expect(extensionForContentType('image/jpeg')).toBe('jpg');
    expect(extensionForContentType('image/png')).toBe('png');
    expect(extensionForContentType('image/webp')).toBe('webp');
  });

  it.each([
    ['a slash', 'r_kitchen/../escape'],
    ['a key separator', 'r_kitchen#META'],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('rejects a roomId containing %s', (_why, roomId) => {
    expect(() => buildEvidenceKey({ ...base, roomId })).toThrow(InvalidEvidenceKeyError);
  });

  it('rejects a tenancyId that would escape its own prefix', () => {
    expect(() => buildEvidenceKey({ ...base, tenancyId: '../other' })).toThrow(
      InvalidEvidenceKeyError,
    );
  });

  it('rejects a photoId containing a slash', () => {
    expect(() => buildEvidenceKey({ ...base, photoId: 'p/../../x' })).toThrow(
      InvalidEvidenceKeyError,
    );
  });
});

describe('tenancyUploadPrefix', () => {
  /**
   * This is the prefix `api-handler`'s `s3:PutObject` grant is scoped to, and
   * the prefix the presigned POST policy pins with `starts-with`. It must end
   * in a slash or it would also match `tenancies/t_abc123-evil/...`.
   */
  it('ends with a slash so it cannot match a sibling tenancy', () => {
    const prefix = tenancyUploadPrefix('t_abc123');
    expect(prefix).toBe('tenancies/t_abc123/');
    expect(prefix.endsWith('/')).toBe(true);
  });

  it('is a prefix of every key built for that tenancy', () => {
    expect(buildEvidenceKey(base).startsWith(tenancyUploadPrefix(base.tenancyId))).toBe(true);
  });

  it('is not a prefix of a key for a tenancy whose id merely starts the same', () => {
    const sibling = buildEvidenceKey({ ...base, tenancyId: 't_abc123456' });
    expect(sibling.startsWith(tenancyUploadPrefix('t_abc123'))).toBe(false);
  });
});

describe('parseEvidenceKey', () => {
  it('round-trips every component that built the key', () => {
    expect(parseEvidenceKey(buildEvidenceKey(base))).toEqual({
      tenancyId: base.tenancyId,
      phase: base.phase,
      roomId: base.roomId,
      photoId: base.photoId,
      extension: 'jpg',
    });
  });

  it('round-trips a MOVEOUT key', () => {
    const key = buildEvidenceKey({ ...base, phase: 'MOVEOUT' });
    expect(parseEvidenceKey(key)?.phase).toBe('MOVEOUT');
  });

  it.each([
    ['a foreign root', 'uploads/t1/MOVEIN/r1/p1.jpg'],
    ['an unknown phase', 'tenancies/t1/MIDDLE/r1/p1.jpg'],
    ['too few segments', 'tenancies/t1/MOVEIN/p1.jpg'],
    ['too many segments', 'tenancies/t1/MOVEIN/r1/sub/p1.jpg'],
    ['no extension', 'tenancies/t1/MOVEIN/r1/p1'],
    ['an empty component', 'tenancies//MOVEIN/r1/p1.jpg'],
  ])('returns undefined for %s', (_why, key) => {
    expect(parseEvidenceKey(key)).toBeUndefined();
  });

  /**
   * An object that appears in the bucket without a parseable key is not an
   * error to retry — it is an object `photo-ingest` must ignore. Returning
   * `undefined` rather than throwing is what lets the handler drop it without
   * burning Lambda retries and landing it in the DLQ.
   */
  it('returns undefined rather than throwing, so ingest can skip the object', () => {
    expect(() => parseEvidenceKey('garbage')).not.toThrow();
    expect(parseEvidenceKey('garbage')).toBeUndefined();
  });

  it('decodes a key that arrived URL-encoded from an S3 event', () => {
    expect(parseEvidenceKey('tenancies/t1/MOVEIN/r1/p1.jpg')?.roomId).toBe('r1');
  });
});
