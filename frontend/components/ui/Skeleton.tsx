import type { CSSProperties, HTMLAttributes } from 'react';
import { cn } from './cn';

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  w?: number | string;
  h?: number | string;
  circle?: boolean;
}

function dim(v: number | string | undefined): string | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'number' ? `${v}px` : v;
}

export function Skeleton({ w, h, circle, className, style, ...rest }: SkeletonProps) {
  const sized: CSSProperties = { width: dim(w), height: dim(h), ...style };
  return (
    <div
      aria-hidden
      className={cn(
        'animate-pulse bg-surface-overlay',
        circle ? 'rounded-full' : 'rounded-token',
        className,
      )}
      style={sized}
      {...rest}
    />
  );
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} h={12} w={i === lines - 1 ? '70%' : '100%'} />
      ))}
    </div>
  );
}
