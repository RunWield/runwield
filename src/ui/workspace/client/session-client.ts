/** Serializable, host-independent Session operations. No transport or storage authority lives here. */
export interface SessionBinding {
    connectionId: string;
    project: string;
    sessionId: string;
}

export interface SessionQuestionChoice {
    value: string;
    label: string;
}

export interface SessionClientQuestion {
    requestId: string;
    interactionId: string;
    prompt: string;
    mode: "text" | "select" | "approval";
    required: boolean;
    placeholder: string;
    choices: SessionQuestionChoice[];
    allowOther: boolean;
}

export interface SessionQuestionFields {
    action: "accept" | "decline" | "cancel";
    answer?: string;
    otherAnswer?: string;
}

export interface SessionQuestionAnswer extends SessionQuestionFields {
    requestId: string;
}

export interface SessionClientItem {
    id: string;
    kind: "user" | "assistant" | "thinking" | "tool" | "system";
    text: string;
    title?: string;
    status?: "in_progress" | "completed" | "failed";
}

export interface SessionClientView {
    connectionId: string;
    project: string;
    connection: "connecting" | "ready" | "incompatible" | "disconnected";
    phase: "empty" | "loading" | "idle" | "streaming" | "awaiting_answer" | "canceling" | "interrupted";
    sessionId: string;
    durableSessionId: string;
    items: SessionClientItem[];
    question: SessionClientQuestion | null;
    error: string;
}

export interface WorkspaceSessionClient {
    create(): Promise<void>;
    load(sessionId: string): Promise<void>;
    send(binding: SessionBinding, text: string): Promise<void>;
    answer(binding: SessionBinding, response: SessionQuestionAnswer): Promise<void>;
    cancel(binding: SessionBinding): Promise<void>;
    close(binding: SessionBinding): Promise<void>;
    observe(listener: (view: SessionClientView) => void): () => void;
}
