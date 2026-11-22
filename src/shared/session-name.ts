/**
 * @module shared/session-name
 * UI-independent persisted Session Name normalization.
 */

import { toolRegistry } from "@runwield/tools";

export function formatSessionTerminalTitle(name: string | null | undefined): string {
    const sanitized = toolRegistry.get("set_session_name").sanitize(name);
    return sanitized ? `W. ${sanitized}` : "W.";
}
