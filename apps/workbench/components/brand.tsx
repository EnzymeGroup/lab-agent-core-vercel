import { cn } from '../lib/utils';

/** Monogram from the configured title. Decorative; callers provide the accessible name. */
export function BrandMark({ title, size = 'md', className }: { title: string; size?: 'sm' | 'md'; className?: string }) {
  return (
    <span aria-hidden="true" className={cn(
      'flex shrink-0 items-center justify-center rounded-md bg-foreground font-semibold text-background',
      size === 'sm' ? 'size-6 text-[11px]' : 'size-7 text-xs',
      className,
    )}>
      {title.slice(0, 1).toUpperCase()}
    </span>
  );
}
