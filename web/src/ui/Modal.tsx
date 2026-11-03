import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export function Modal({
  children,
  className,
  description,
  onOpenChange,
  open,
  title,
}: {
  children: ReactNode;
  className?: string;
  description?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) {
  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className={`modal${className ? ` ${className}` : ''}`}>
          <div className="modal-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close aria-label="Close" className="icon-button" type="button">
              <X />
            </Dialog.Close>
          </div>
          {description ? (
            <Dialog.Description className="modal-description">{description}</Dialog.Description>
          ) : null}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
