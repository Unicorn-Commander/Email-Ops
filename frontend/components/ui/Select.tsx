import { forwardRef } from 'react';
import type { SelectHTMLAttributes } from 'react';
import { cn } from './cn';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { invalid, className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'block w-full appearance-none rounded-token bg-surface-base text-primary',
        'min-h-[44px] py-2 pl-3 pr-9 text-base sm:min-h-[36px] sm:text-sm',
        'border bg-[length:1rem] bg-[right_0.65rem_center] bg-no-repeat transition-colors duration-fast ease-token',
        "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%2716%27%20height=%2716%27%20fill=%27none%27%20stroke=%27%238a8a96%27%20stroke-width=%272%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27%3E%3Cpath%20d=%27M4%206l4%204%204-4%27/%3E%3C/svg%3E')]",
        'focus:outline-none focus:ring-2',
        invalid
          ? 'border-danger/50 focus:border-danger focus:ring-danger/40'
          : 'border-border focus:border-accent focus:ring-accent/40',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});
