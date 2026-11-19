import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";

/** Enforce the active session's prompt at the last boundary before provider dispatch. */
export function projectProviderSystemPrompt(messages: Message[], systemPrompt: string): Message[] {
    const current = getCurrentSystemMessage(messages);
    return [
        {
            role: "system",
            content: systemPrompt,
            ...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
            timestamp: current?.timestamp ?? Date.now(),
        },
        ...messages.filter((message) => message.role !== "system"),
    ];
}
