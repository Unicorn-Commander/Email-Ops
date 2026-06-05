import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  leading?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-gradient-to-br from-accent to-[rgb(var(--accent-2))] text-accent-contrast shadow-lg shadow-accent/30 transition hover:brightness-110 focus-visible:ring-accent/60',
  secondary:
    'border border-border bg-surface-raised text-secondary hover:bg-surface-overlay hover:text-primary focus-visible:ring-accent/40',
  ghost:
    'bg-transparent text-secondary hover:bg-surface-raised hover:text-primary focus-visible:ring-accent/40',
  danger:
    'border border-danger/30 bg-danger-subtle text-danger hover:bg-danger/20 focus-visible:ring-danger/50',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-[44px] gap-1.5 px-2.5 text-xs sm:min-h-[32px]',
  md: 'min-h-[44px] gap-2 px-3.5 text-sm sm:min-h-[36px]',
  lg: 'min-h-[44px] gap-2 px-4 text-sm',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', block, leading, className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap rounded-token font-medium',
        'transition-colors duration-fast ease-token',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-0',
        'disabled:pointer-events-none disabled:opacity-40',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {leading}
      {children}
    </button>
  );
});
