import type { SessionRuntime, SessionRuntimeOptions } from "./contract.ts";
import { createSessionRuntime as createInteractiveRuntime } from "./session-runtime.ts";

export type {
    CancelSessionResult,
    CloseAllSessionsResult,
    CloseSessionResult,
    ContextUsageSnapshot,
    CreateSessionOptions,
    CreatedSession,
    ManagedSessionSnapshot,
    PromptTurnContext,
    ResumedSession,
    ResumeSessionOptions,
    SessionModelSnapshot,
    SessionRuntime,
    SessionRuntimeEventListener,
    SessionRuntimeOptions,
    SessionSnapshot,
    SetInteractionAdapterResult,
    SteerSessionResult,
    UserPromptOptions,
    UserPromptResult,
} from "./contract.ts";
export { SessionTurnInProgressError } from "./turn-in-progress.ts";

/** Create a Session runtime with its default local storage and execution services. */
export const createSessionRuntime: (options?: SessionRuntimeOptions) => SessionRuntime = createInteractiveRuntime;
