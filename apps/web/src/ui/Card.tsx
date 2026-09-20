import type { ReactNode } from 'react';

/**
 * A raised surface.
 *
 * Used sparingly on purpose. The brief's instruction — "do NOT turn every
 * element into a card" — is the whole reason this has a `flat` variant and why
 * most lists in the app are hairline-separated rows instead. A card means *this
 * is a discrete object you can act on*: a room, a document, a claim summary.
 */
export interface CardProps {
  /** `flat` drops the shadow — for cards inside an already-raised surface. */
  readonly variant?: 'raised' | 'flat' | 'sunk';
  readonly as?: 'div' | 'li' | 'section' | 'article';
  readonly className?: string;
  readonly children: ReactNode;
  readonly 'data-testid'?: string;
}

const VARIANT = {
  raised: 'bg-surface border border-line shadow-sm',
  flat: 'bg-surface border border-line',
  sunk: 'bg-sunk border border-line',
} as const;

export function Card({ variant = 'raised', as: Tag = 'div', className, children, ...rest }: CardProps) {
  return (
    <Tag
      className={['rounded-2xl', VARIANT[variant], className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </Tag>
  );
}
