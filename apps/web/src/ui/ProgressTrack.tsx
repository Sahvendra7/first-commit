/**
 * A determinate progress bar for a server job.
 *
 * `<progress>` is styled inconsistently across engines and cannot carry a
 * gradient or a rounded track, so the bar is drawn with divs — but the semantic
 * element stays, visually hidden, so assistive technology reads a real
 * progressbar with a real value rather than a decorative strip.
 *
 * Values come from the server's own job record. This component never invents a
 * total, and the caller is responsible for not passing one.
 */
export interface ProgressTrackProps {
  readonly done: number;
  readonly total: number;
  readonly label: string;
  readonly className?: string;
  readonly 'data-testid'?: string;
}

export function ProgressTrack({ done, total, label, className, ...rest }: ProgressTrackProps) {
  const max = Math.max(1, total);
  const pct = Math.min(100, Math.max(0, (done / max) * 100));
  return (
    <div className={className ?? ''} {...rest}>
      <progress value={done} max={max} className="sr-only">
        {label}
      </progress>
      <div aria-hidden="true" className="h-1.5 w-full overflow-hidden rounded-full bg-paper-deep">
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-[var(--dur-3)] ease-[var(--ease)]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
