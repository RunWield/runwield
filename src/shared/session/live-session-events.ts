/** A bounded view of a running turn. The transcript remains the conversation history. */

import type { SessionRuntimeEvent } from "./session-runtime-events.ts";

export function appendLiveSessionEvent(events: SessionRuntimeEvent[], event: SessionRuntimeEvent) {
    if (event.eventId) return; // Saved history is loaded through transcript pagination.
    const previous = events.at(-1);
    if (
        previous && previous.type === event.type &&
        (event.type === "assistant_text_delta" || event.type === "assistant_thinking_delta") &&
        "messageId" in previous && previous.messageId === event.messageId && "delta" in previous
    ) {
        events[events.length - 1] = { ...event, delta: previous.delta + event.delta };
    } else {
        events.push(event);
    }
    if (events.length > 1000) {
        const busy = events.findLast((item) => item.type === "busy_changed");
        events.splice(0, events.length - 1000);
        // A newly attached surface still needs Core's current busy state after a long turn.
        if (busy && !events.includes(busy)) events.splice(0, 1, busy);
    }
}
