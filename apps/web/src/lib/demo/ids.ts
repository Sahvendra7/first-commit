/**
 * Deterministic filler for fixture fields that must be *shaped* like real
 * values without pretending to be real ones.
 *
 * The digests below are not hashes of anything. They are valid lowercase
 * 64-hex strings so `sha256Schema` accepts them and the tamper-evidence UI has
 * something to render. Demo fixtures must never be served to a real user
 * (§8 rule 3), and this is one of the reasons why.
 */
export function fixtureDigest(seed: string): string {
  let h = 0x811c9dc5;
  const out: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 0x01000193) >>> 0;
    out.push((h & 0xf).toString(16));
  }
  return out.join('');
}
