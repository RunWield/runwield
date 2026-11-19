/**
 * @module ui/tui/terminal-title
 * Helpers for RunWield terminal tab/window titles.
 */

import { formatSessionTerminalTitle, sanitizeSessionName } from "../../shared/session-name.ts";
import { getTUI } from "./tui.ts";

export { sanitizeSessionName };

/** Format a terminal title from a Session Name. */
export function formatTerminalTitle(name: string | null | undefined): string {
    return formatSessionTerminalTitle(name);
}

/** Best-effort Terminal Title update for a Session Name. */
export function setTerminalTitleForName(name: string | null | undefined): string {
    const title = formatTerminalTitle(name);
    try {
        const { terminal } = getTUI();
        terminal.setTitle(title);
    } catch {
        // Terminal title updates are cosmetic. Never break the TUI if unavailable.
    }
    return title;
}
