import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

export interface RunWieldDialogProps {
    trigger: ReactNode;
    title: string;
    description: string;
    children?: ReactNode;
    footer: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    busy?: boolean;
}

export function RunWieldDialog({
    trigger,
    title,
    description,
    children,
    footer,
    open,
    onOpenChange,
    busy = false,
}: RunWieldDialogProps) {
    return (
        <Dialog.Root
            open={open}
            onOpenChange={(next) => {
                if (!busy) onOpenChange(next);
            }}
        >
            <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="rw-dialog-backdrop" />
                <div className="rw-dialog-positioner">
                    <Dialog.Content
                        className="rw-dialog-panel"
                        aria-busy={busy}
                        onEscapeKeyDown={(event) => {
                            if (busy) event.preventDefault();
                        }}
                        onPointerDownOutside={(event) => {
                            if (busy) event.preventDefault();
                        }}
                    >
                        <header className="rw-dialog-header">
                            <Dialog.Title className="rw-dialog-title">{title}</Dialog.Title>
                            <Dialog.Description className="rw-dialog-description">{description}</Dialog.Description>
                        </header>
                        {children && <div className="rw-dialog-body">{children}</div>}
                        <footer className="rw-dialog-footer">{footer}</footer>
                    </Dialog.Content>
                </div>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
