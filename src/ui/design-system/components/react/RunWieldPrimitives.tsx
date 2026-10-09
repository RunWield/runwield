import React from "react";
import { RunWieldIconButton } from "./RunWieldIconButton.tsx";
import * as Tabs from "@radix-ui/react-tabs";

import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export type RunWieldActionVariant = "primary" | "secondary" | "danger";

export interface RunWieldButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: RunWieldActionVariant;
}

export interface RunWieldLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
    variant?: RunWieldActionVariant;
}

export interface RunWieldCardProps extends HTMLAttributes<HTMLElement> {
    class?: string;
}

export interface RunWieldPanelToggleProps {
    side: "left" | "right";
    collapsed: boolean;
    label: string;
    controls: string;
    onClick: () => void;
}

export interface RunWieldThinkingDotsProps {
    label?: string;
    className?: string;
    showLabel?: boolean;
}

export interface RunWieldTab {
    value: string;
    label: string;
    children: ReactNode;
}

export interface RunWieldTabsProps {
    defaultValue: string;
    tabs: RunWieldTab[];
    value?: string;
    onValueChange?: (value: string) => void;
    keepMounted?: boolean;
    label?: string;
}

type ClassNamePart = string | undefined | false | null;

function classNames(parts: ClassNamePart[]) {
    return parts.filter(Boolean).join(" ");
}

export function RunWieldButton({ variant = "secondary", className, children, ...props }: RunWieldButtonProps) {
    const variantClass = variant === "primary"
        ? "primary-action"
        : variant === "danger"
        ? "danger-action"
        : "secondary-action";
    return React.createElement(
        "button",
        { type: "button", ...props, className: classNames([variantClass, className]) },
        children,
    );
}

export function RunWieldPanelToggle({ side, collapsed, label, controls, onClick }: RunWieldPanelToggleProps) {
    const pointsLeft = (side === "left") !== collapsed;
    const title = `${collapsed ? "Show" : "Collapse"} ${label}`;
    return (
        <RunWieldIconButton
            className="rw-panel-toggle"
            aria-label={title}
            title={title}
            aria-expanded={!collapsed}
            aria-controls={controls}
            onClick={onClick}
        >
            <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor">
                <path d="M5 4v16M19 4v16" strokeWidth="1.5" strokeLinecap="round" />
                <path
                    d={pointsLeft ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"}
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
        </RunWieldIconButton>
    );
}

/**
 * Use this for links that should look like RunWield actions. Navigation remains
 * an anchor, so browser affordances and accessibility semantics stay intact.
 */
export function RunWieldLink({ variant = "secondary", className, children, ...props }: RunWieldLinkProps) {
    const variantClass = variant === "primary"
        ? "primary-action"
        : variant === "danger"
        ? "danger-action"
        : "secondary-action";
    return React.createElement("a", { ...props, className: classNames([variantClass, className]) }, children);
}

export function RunWieldCard({ className, children, ...props }: RunWieldCardProps) {
    return React.createElement("article", { ...props, className: classNames(["plan-card", className]) }, children);
}

export function RunWieldThinkingDots({ label = "Thinking", className, showLabel = true }: RunWieldThinkingDotsProps) {
    return (
        <span className={classNames(["rw-thinking-dots", className])} role="status" aria-label={label}>
            <span className="rw-thinking-glyph" aria-hidden="true" />
            {showLabel && <span aria-hidden="true">{label}</span>}
        </span>
    );
}

export function RunWieldTabs(
    { defaultValue, tabs, value, onValueChange, keepMounted = false, label = "Review sections" }: RunWieldTabsProps,
) {
    return React.createElement(
        Tabs.Root,
        { defaultValue, value, onValueChange, className: "rw-react-tabs" },
        React.createElement(
            Tabs.List,
            { className: "tabs", "aria-label": label },
            tabs.map((tab) =>
                React.createElement(
                    Tabs.Trigger,
                    { key: tab.value, value: tab.value, className: "rw-react-tabs-trigger" },
                    tab.label,
                )
            ),
        ),
        tabs.map((tab) =>
            React.createElement(
                Tabs.Content,
                {
                    key: tab.value,
                    value: tab.value,
                    forceMount: keepMounted || undefined,
                    hidden: keepMounted && value !== tab.value,
                    className: "rw-react-tabs-content",
                },
                tab.children,
            )
        ),
    );
}
