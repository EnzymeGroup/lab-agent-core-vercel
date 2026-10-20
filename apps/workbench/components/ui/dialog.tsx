'use client';

import { Dialog as Primitive } from 'radix-ui';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** Modal with title, optional description, a labeled close button and a scrollable body. */
export function Dialog({ title, description, closeLabel, onClose, className, children }: {
  title: string;
  description?: ReactNode;
  closeLabel: string;
  onClose(): void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Primitive.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Primitive.Content
          className={cn(
            'fixed inset-x-3 top-[5vh] z-50 mx-auto flex max-h-[90vh] max-w-3xl flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg',
            className,
          )}
        >
          <header className="flex items-start justify-between gap-4 border-b px-5 py-4">
            <div className="min-w-0">
              <Primitive.Title className="text-base font-semibold">{title}</Primitive.Title>
              {description
                ? <Primitive.Description className="mt-0.5 text-xs break-all text-muted-foreground">{description}</Primitive.Description>
                : <Primitive.Description className="sr-only">{title}</Primitive.Description>}
            </div>
            <Primitive.Close aria-label={closeLabel} className="-mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="size-4" />
            </Primitive.Close>
          </header>
          <div className="scroll-area min-h-0 flex-1 px-5 py-4">{children}</div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
