import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from './cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'block w-full rounded-token bg-surface-base text-primary placeholder:text-muted',
        'min-h-[44px] px-3 py-2 text-base sm:min-h-[36px] sm:text-sm',
        'border transition-colors duration-fast ease-token',
        'focus:outline-none focus:ring-2',
        invalid
          ? 'border-danger/50 focus:border-danger focus:ring-danger/40'
          : 'border-border focus:border-accent focus:ring-accent/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  );
});
