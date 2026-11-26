import type { RuntimeKeyboardHelpItem } from "@runwield/session-runtime/events";
/**
 * @module shared/session/session-help
 *
 * Adapter-neutral help payloads for interactive SessionRuntime consumers.
 */

const KEYBOARD_HELP_TITLE = "Keyboard shortcuts";

const KEYBOARD_HELP_ITEMS = Object.freeze([
    Object.freeze({ key: "esc", description: "to interrupt" }),
    Object.freeze({ key: "ctrl+c", description: "to clear input" }),
    Object.freeze({ key: "ctrl+c twice", description: "to exit" }),
    Object.freeze({ key: "ctrl+l", description: "to redraw the terminal" }),
    Object.freeze({ key: "shift+tab", description: "to cycle thinking level" }),
    Object.freeze({ key: "ctrl+o", description: "to expand/collapse tool groups" }),
    Object.freeze({ key: "ctrl+]", description: "to switch Session sidebar tabs" }),
    Object.freeze({ key: "alt+]", description: "to open a Session artifact in the Markdown reader" }),
    Object.freeze({ key: "ctrl+t", description: "to toggle thinking block visibility" }),
    Object.freeze({ key: "ctrl+g", description: "for external editor (not-implemented)" }),
    Object.freeze({ key: "ctrl+v", description: "to paste image" }),
    Object.freeze({ key: "shift+enter", description: "to insert newline" }),
    Object.freeze({ key: "/", description: "for commands" }),
    Object.freeze({ key: "!", description: "to run bash" }),
    Object.freeze({ key: "!!", description: "to run bash (no context)" }),
]);

export interface SessionHelpPayload {
    title: string;
    items: RuntimeKeyboardHelpItem[];
}

/**
 * Return a clone of the canonical keyboard-help payload so event consumers
 * cannot mutate future Runtime responses.
 */
export function getSessionKeyboardHelp(): SessionHelpPayload {
    return {
        title: KEYBOARD_HELP_TITLE,
        items: KEYBOARD_HELP_ITEMS.map((item) => ({ ...item })),
    };
}
