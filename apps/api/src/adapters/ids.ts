/**
 * Identifier minting.
 *
 * Ids must satisfy `idSchema` in the shared contract: 1–64 chars,
 * `^[A-Za-z0-9_-]+$`, and above all no `#`, which is the DynamoDB key
 * separator. A `#` in an id could forge a sort key into another partition, so
 * the alphabet here is chosen to make that impossible by construction rather
 * than by validation.
 *
 * Injected into the domain as a function rather than imported by it, so domain
 * tests stay deterministic and no domain module reaches for a random source.
 */
import { randomUUID } from 'node:crypto';

/** 32 hex characters, no separators. URL-safe, key-safe, collision-safe. */
function token(): string {
  return randomUUID().replace(/-/g, '');
}

export const newTenancyId = (): string => `t_${token()}`;
export const newRoomId = (): string => `r_${token()}`;
export const newPhotoId = (): string => `p_${token()}`;
export const newJobId = (): string => `j_${token()}`;
export const newDocumentId = (): string => `d_${token()}`;
