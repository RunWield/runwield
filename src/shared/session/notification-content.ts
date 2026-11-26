/**
 * @module shared/session/notification-content
 * Browser-safe RunWield notification vocabulary and common policy.
 */

import type { RuntimeAttentionNotificationEventName } from "@runwield/session-runtime/events";

export type NotificationEventName = RuntimeAttentionNotificationEventName | "compactionFinished";

export type NotificationEventSettings = Partial<Record<NotificationEventName, boolean>>;

export type CommonNotificationPolicy = {
    enabled: boolean;
    events: Record<NotificationEventName, boolean>;
    suppressWhenFocused: boolean;
};

export type BrowserNotificationPolicy = {
    enabled: boolean;
    events: { agentStopped: boolean };
    suppressWhenFocused: boolean;
};

export type NotificationSettingsRecord = {
    enabled?: boolean;
    events?: NotificationEventSettings;
    suppressWhenFocused?: boolean;
};

const NOTIFICATION_EVENTS: readonly NotificationEventName[] = [
    "agentStopped",
    "planWritten",
    "userInterview",
    "compactionFinished",
];

const EVENT_LABELS: Record<NotificationEventName, string> = {
    agentStopped: "Agent stopped",
    planWritten: "Plan ready",
    userInterview: "Input requested",
    compactionFinished: "Compaction finished",
};

const EVENT_MESSAGES: Record<NotificationEventName, string> = {
    agentStopped: "The agent has stopped and is waiting for you.",
    planWritten: "A plan is ready for review or approval.",
    userInterview: "The agent is asking you a question.",
    compactionFinished: "The /compact command finished. Return to view the result.",
};

export function isNotificationEventName(eventName: string): eventName is NotificationEventName {
    return NOTIFICATION_EVENTS.includes(eventName as NotificationEventName);
}

export function getNotificationEventLabel(eventName: NotificationEventName): string {
    return EVENT_LABELS[eventName];
}

export function getNotificationBaseMessage(eventName: NotificationEventName): string {
    return EVENT_MESSAGES[eventName];
}

export function buildSharedNotificationTitle(
    eventName: NotificationEventName,
    sessionName: string,
    agentName?: string,
): string {
    const agentPrefix = agentName ? `${agentName}: ` : "";
    return `${agentPrefix}${getNotificationEventLabel(eventName)} — ${sessionName}`;
}

export function normalizeNotificationPolicy(
    raw: NotificationSettingsRecord | null | undefined,
): CommonNotificationPolicy {
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const eventsRaw =
        record.events && typeof record.events === "object" && !Array.isArray(record.events) ? record.events : {};

    return {
        enabled: record.enabled !== false,
        events: {
            agentStopped: eventsRaw.agentStopped !== false,
            planWritten: eventsRaw.planWritten !== false,
            userInterview: eventsRaw.userInterview !== false,
            compactionFinished: eventsRaw.compactionFinished !== false,
        },
        suppressWhenFocused: record.suppressWhenFocused !== false,
    };
}

export function normalizeBrowserNotificationPolicy(
    raw: NotificationSettingsRecord | null | undefined,
): BrowserNotificationPolicy {
    const policy = normalizeNotificationPolicy(raw);
    return {
        enabled: policy.enabled,
        events: { agentStopped: policy.events.agentStopped },
        suppressWhenFocused: policy.suppressWhenFocused,
    };
}
