import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export type BadgeVariant =
  | 'neutral'
  | 'accent'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'keep'
  | 'review'
  | 'delete'
  | 'protected';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  dot?: boolean;
}

const VARIANTS: Record<BadgeVariant, string> = {
  neutral: 'bg-surface-overlay text-tertiary',
  accent: 'bg-accent/15 text-accent',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  danger: 'bg-danger-subtle text-danger',
  info: 'bg-info-subtle text-info',
  keep: 'bg-keep-subtle text-keep',
  review: 'bg-review-subtle text-review',
  delete: 'bg-delete-subtle text-delete',
  protected: 'bg-protected-subtle text-protected',
};

export function Badge({ variant = 'neutral', dot, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-token px-2 py-0.5 text-xs font-medium leading-5',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {dot && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}
