import { type RefObject, useEffect, useId, useRef } from "react";
import { RunWieldButton } from "./RunWieldPrimitives.tsx";

export interface ConfirmationDialogProps {
    title: string;
    detail: string;
    onContinue: () => void;
    onQuit: () => void;
    returnFocus?: RefObject<HTMLButtonElement | null>;
}

/** Native modal containment, Escape dismissal, and focus restoration. */
export function RunWieldConfirmationDialog({
    title,
    detail,
    onContinue,
    onQuit,
    returnFocus,
}: ConfirmationDialogProps) {
    const dialog = useRef<HTMLDialogElement>(null);
    const quit = useRef<HTMLButtonElement>(null);
    const titleId = useId();
    useEffect(() => {
        const previous = returnFocus?.current || document.activeElement;
        dialog.current?.showModal();
        quit.current?.focus();
        return () => {
            dialog.current?.close();
            if (previous instanceof HTMLElement) previous.focus();
        };
    }, []);
    return (
        <dialog
            ref={dialog}
            className="rw-confirmation-dialog"
            aria-labelledby={titleId}
            onKeyDown={(event) => {
                if (event.key !== "Tab") return;
                const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>("button");
                if (!buttons?.length) return;
                const first = buttons[0];
                const last = buttons[buttons.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }}
            onCancel={(event) => {
                event.preventDefault();
                onQuit();
            }}
            onClick={(event) => {
                if (event.target === dialog.current) onQuit();
            }}
        >
            <h2 id={titleId}>{title}</h2>
            <p className="rw-confirmation-detail">{detail}</p>
            <div className="rw-confirmation-actions">
                <RunWieldButton variant="primary" onClick={onContinue}>
                    Continue
                </RunWieldButton>
                <button ref={quit} type="button" className="secondary-action" onClick={onQuit}>
                    Quit
                </button>
            </div>
        </dialog>
    );
}
