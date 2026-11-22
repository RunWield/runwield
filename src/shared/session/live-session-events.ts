/** A bounded view of a running turn. The transcript remains the conversation history. */

import type { SessionRuntimeEvent } from "./session-runtime-events.js";

interface LiveEventSequence {
    emitted: number;
    evictedThrough: number;
    retained: number[];
}
const sequences = new WeakMap<SessionRuntimeEvent[], LiveEventSequence>();
export function liveSessionEventSequence(events: SessionRuntimeEvent[]) {
    const sequence = sequences.get(events);
    return { eventSequence: sequence?.emitted || 0, eventEvictedThrough: sequence?.evictedThrough || 0 };
}

/** Segment replacement drops live payload, not this owner's emitted sequence. */
export function clearLiveSessionEvents(events: SessionRuntimeEvent[]) {
    const sequence = sequences.get(events);
    if (sequence) {
        sequence.evictedThrough = sequence.emitted;
        sequence.retained = [];
    }
    events.length = 0;
}

export function appendLiveSessionEvent(events: SessionRuntimeEvent[], event: SessionRuntimeEvent) {
    if (event.eventId) return; // Saved history is loaded through transcript pagination.
    let sequence = sequences.get(events);
    if (!sequence) {
        sequence = { emitted: 0, evictedThrough: 0, retained: [] };
        sequences.set(events, sequence);
    }
    sequence.emitted++;
    const previous = events.at(-1);
    if (
        previous &&
        previous.type === event.type &&
        (event.type === "assistant_text_delta" || event.type === "assistant_thinking_delta") &&
        "messageId" in previous &&
        previous.messageId === event.messageId &&
        "delta" in previous
    ) {
        events[events.length - 1] = { ...event, delta: previous.delta + event.delta };
        sequence.retained[events.length - 1] = sequence.emitted;
    } else {
        events.push(event);
        sequence.retained.push(sequence.emitted);
    }
    if (events.length > 1000) {
        const busy = events.findLast((item) => item.type === "busy_changed");
        const removed = events.length - 1000;
        sequence.evictedThrough = Math.max(sequence.evictedThrough, ...sequence.retained.splice(0, removed));
        events.splice(0, removed);
        // A newly attached surface still needs Core's current busy state after a long turn.
        if (busy && !events.includes(busy)) {
            sequence.evictedThrough = Math.max(sequence.evictedThrough, sequence.retained[0]);
            events.splice(0, 1, busy);
        }
    }
}
