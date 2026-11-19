// @jsxImportSource preact
/**
 * Shared RunWield Dialog primitive.
 */

import * as dialog from "@zag-js/dialog";
import { normalizeProps, Portal, useMachine } from "@zag-js/preact";
import { useId } from "preact/hooks";
import type { ComponentType, CSSProperties, HTMLAttributes, JSX, Key, ReactElement, ReactNode } from "react";
import type { PortalProps } from "@zag-js/preact";
import type { ButtonProps, ButtonVariant } from "./Button.tsx";

interface DialogPortalProps extends PortalProps {
    children?: ReactNode;
}

// The JSX checker uses React while this existing runtime portal comes from Preact.
const DialogPortal = Portal as ComponentType<DialogPortalProps>;

export type DialogActionVariant = ButtonVariant;

export interface DialogActionDescriptor extends ButtonProps {
    key?: Key;
    label: ReactNode;
    variant?: DialogActionVariant;
}

export type DialogFooterAction = ReactNode | DialogActionDescriptor;
type DialogPropTypes = JSX.IntrinsicElements & {
    element: HTMLAttributes<HTMLElement>;
    style: CSSProperties;
};

export type DialogApi = dialog.Api<DialogPropTypes>;

export interface DialogProps {
    id?: string;
    trigger?: ReactNode | ((api: DialogApi) => ReactNode);
    title?: ReactNode;
    description?: ReactNode;
    footer?: DialogFooterAction | DialogFooterAction[];
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    modal?: boolean;
    closeOnEscape?: boolean;
    closeOnInteractOutside?: boolean;
    class?: string;
    className?: string;
    children?: ReactNode;
}

type ClassNamePart = string | undefined | false | null;

function classNames(parts: ClassNamePart[]) {
    return parts.filter(Boolean).join(" ");
}

function actionClassName(variant: DialogActionVariant = "secondary") {
    if (variant === "primary") return "primary-action";
    if (variant === "danger") return "danger-action";
    return "secondary-action";
}

function DialogAction(action: DialogFooterAction, index: number) {
    if (!action) return null;
    // The existing JavaScript API accepts both renderable children and action descriptors.
    if ((action as ReactElement).type || typeof action !== "object") return action as ReactNode;
    const {
        label,
        variant = "secondary",
        class: className,
        className: compatClassName,
        ...props
    } = action as DialogActionDescriptor;
    return (
        <button
            key={(action as DialogActionDescriptor).key || index}
            {...props}
            className={classNames([actionClassName(variant), className, compatClassName])}
        >
            {label}
        </button>
    );
}

export function Dialog({
    id,
    trigger,
    title,
    description,
    footer,
    open,
    defaultOpen = false,
    onOpenChange,
    modal = true,
    closeOnEscape = true,
    closeOnInteractOutside = true,
    class: className,
    className: compatClassName,
    children,
}: DialogProps) {
    const generatedId = useId();
    // @ts-expect-error Zag's machine generic is incompatible with the Preact hook's broad schema type.
    const service = useMachine(dialog.machine, {
        id: id || generatedId,
        open,
        defaultOpen,
        modal,
        closeOnEscape,
        closeOnInteractOutside,
        onOpenChange: (details: dialog.OpenChangeDetails) => onOpenChange?.(details.open),
    });
    // @ts-expect-error The service returned by the Preact hook retains the broad schema type.
    const api = dialog.connect(service, normalizeProps) as DialogApi;
    const actions = Array.isArray(footer) ? footer : footer ? [footer] : [];
    const triggerProps = api.getTriggerProps();
    const backdropProps = api.getBackdropProps();
    const positionerProps = api.getPositionerProps();
    const contentProps = api.getContentProps();
    const titleProps = api.getTitleProps();
    const descriptionProps = api.getDescriptionProps();

    return (
        <>
            {typeof trigger === "function" ? (
                trigger(api)
            ) : trigger ? (
                <button {...triggerProps} className="secondary-action">
                    {trigger}
                </button>
            ) : null}
            {api.open ? (
                <DialogPortal>
                    <div {...backdropProps} className="rw-dialog-backdrop" />
                    <div {...positionerProps} className="rw-dialog-positioner">
                        <section
                            {...contentProps}
                            className={classNames(["rw-dialog-panel", className, compatClassName])}
                        >
                            <header className="rw-dialog-header">
                                {title ? (
                                    <h2 {...titleProps} className="rw-dialog-title">
                                        {title}
                                    </h2>
                                ) : null}
                                {description ? (
                                    <p {...descriptionProps} className="rw-dialog-description">
                                        {description}
                                    </p>
                                ) : null}
                            </header>
                            <div className="rw-dialog-body">{children}</div>
                            {actions.length ? (
                                <footer className="rw-dialog-footer">{actions.map(DialogAction)}</footer>
                            ) : null}
                        </section>
                    </div>
                </DialogPortal>
            ) : null}
        </>
    );
}
