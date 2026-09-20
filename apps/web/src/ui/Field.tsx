import type { InputHTMLAttributes, ReactNode } from 'react';

/**
 * A labelled input with its hint and its error, wired together.
 *
 * The wiring is the reason this exists. `aria-describedby` for the hint and
 * `aria-errormessage` for the error have to point at ids that actually exist,
 * and the error one must only be present when there *is* an error — three
 * conditional attributes that were being hand-assembled at every call site.
 *
 * `text-base` on the control is not a style choice: iOS Safari zooms the
 * viewport on focus for anything under 16px, which on the capture flow means
 * the page jumps every time a tenant taps a field.
 */
export const controlClass =
  'block min-h-11 w-full rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-base text-ink ' +
  'shadow-xs transition-[border-color,box-shadow] duration-[var(--dur-1)] ' +
  'placeholder:text-ink-4 hover:border-ink-4 ' +
  'focus:border-brand-hi focus:outline-none focus:ring-2 focus:ring-brand-hi/25 ' +
  'disabled:bg-paper-deep disabled:text-ink-3 ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-danger/20';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly id: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  /** Rendered only when truthy, which is also what switches `aria-invalid` on. */
  readonly error?: string | undefined;
  /** A trailing control on the same row — "Add", a unit, a toggle. */
  readonly trailing?: ReactNode;
  readonly fieldClassName?: string;
}

export function Field({
  id,
  label,
  hint,
  error,
  trailing,
  fieldClassName,
  className,
  ...rest
}: FieldProps) {
  const hintId = hint ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={fieldClassName ?? ''}>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="mt-0.5 text-xs text-ink-3">
          {hint}
        </p>
      ) : null}
      <div className={trailing ? 'mt-1.5 flex gap-2' : 'mt-1.5'}>
        <input
          id={id}
          className={[controlClass, className ?? ''].filter(Boolean).join(' ')}
          {...(hintId ? { 'aria-describedby': hintId } : {})}
          {...(error ? { 'aria-invalid': true, 'aria-errormessage': errorId } : {})}
          {...rest}
        />
        {trailing}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
