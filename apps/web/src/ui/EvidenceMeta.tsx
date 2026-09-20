/**
 * What the ledger attests to about one photograph, said in the tenant's terms.
 *
 * The brief is explicit that the product communicates the *outcome* rather than
 * the infrastructure — "Recorded", "Server timestamped", "Integrity hash
 * stored", not SHA-256 and S3. So the digest is labelled "Integrity hash" and
 * the raw hex is available but demoted: truncated, in `font-mono`, with the
 * full value on the element's `title`.
 *
 * It stays visible rather than hiding behind a disclosure, because the
 * tamper-evidence *is* the product — but it is typographically subordinate to
 * the photograph it describes, which is the actual evidence.
 */
export interface EvidenceMetaProps {
  readonly label: string;
  /**
   * `PhotoRef.receivedAt` — the **server** clock. Never `exifCapturedAt`,
   * which is device-reported and is not what the record attests to.
   */
  readonly receivedAt?: string;
  readonly sha256?: string;
  readonly className?: string;
  readonly 'data-testid'?: string;
}

/** Enough of the digest to compare by eye, without a line of hex on a phone. */
export function shortDigest(sha256: string): string {
  return `${sha256.slice(0, 8)}…${sha256.slice(-4)}`;
}

export function formatReceivedAt(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function EvidenceMeta({
  label,
  receivedAt,
  sha256,
  className,
  ...rest
}: EvidenceMetaProps) {
  return (
    <div className={className ?? ''} {...rest}>
      <p className="text-micro font-semibold uppercase text-ink-3">{label}</p>
      {receivedAt ? (
        <p className="tnum mt-1 text-xs font-medium text-ink-2">{formatReceivedAt(receivedAt)}</p>
      ) : null}
      {sha256 ? (
        <p className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-3" title={sha256}>
          <VerifiedGlyph className="h-3 w-3 shrink-0 text-ok" />
          <span className="font-mono">{shortDigest(sha256)}</span>
        </p>
      ) : null}
    </div>
  );
}

/** A seal, not a tick: this marks an integrity record, not a passed check. */
export function VerifiedGlyph({ className }: { readonly className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" aria-hidden="true">
      <path
        d="M8 1.2 13.6 3.4v4.2c0 3.2-2.2 6-5.6 7.2-3.4-1.2-5.6-4-5.6-7.2V3.4L8 1.2Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="m5.6 8 1.7 1.7 3.1-3.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
