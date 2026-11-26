import type { AuthMethod, InitializeResponse } from "@agentclientprotocol/sdk/unstable";
import type { JsonRecord } from "@runwield/parsing/jsonc";
import type { SessionRuntime } from "@runwield/session-runtime";
import type { InteractiveSessionRuntime } from "@runwield/session-runtime/services";
import type { AcpCommandCatalog } from "./event-mapper.ts";
import type { AcpReviewServices } from "./interaction-mapper.ts";
import type { AcpModelOption } from "./model-options.ts";
import type { AcpTransport } from "./transport.ts";

/** Session operations used by one ACP connection. Implementations can share an underlying runtime. */
export type AcpServerRuntime = Pick<
    SessionRuntime,
    | "answerInteraction"
    | "cancelSession"
    | "promptUserTurn"
    | "setInteractionAdapter"
    | "steerSession"
    | "subscribeSessionEvents"
> &
    Pick<
        InteractiveSessionRuntime,
        | "archiveSavedSession"
        | "canArchiveSavedSessions"
        | "closeSessionWhenIdle"
        | "createSession"
        | "getSessionSnapshot"
        | "listSessionPromptTemplates"
        | "listSessionSkills"
        | "queueNextTurnMessage"
        | "replaySession"
        | "resumeSession"
        | "setSessionThinkingLevel"
    >;

/** One slash command and the callbacks that connect it to the active ACP prompt. */
export interface AcpCommandInvocation {
    readonly commandName: string;
    readonly args: string[];
    readonly requestId?: string;
    /** The runtime Session currently mapped to this ACP Session, including replacements. */
    readonly runtimeSessionId: string;
    /** Whether the client canceled this command prompt. */
    readonly cancelled: boolean;
    /** Send a command message through the prompt update stream. */
    sendMessage(text: string, isError?: boolean): void;
    /** Attach the ACP Session to the runtime Session that replaced it. */
    replaceRuntimeSession(nextSessionId: string): void;
}

/** Host behavior for built-in slash commands and active Plan reviews. */
export interface AcpServerCommandHost {
    /** Execute a slash command, including the host's handling of unrecognized commands. */
    execute(invocation: AcpCommandInvocation): Promise<void>;
    /** Reopen the Session's active Plan review. */
    reopenPlanReview(sessionId: string): Promise<{ message: string; url?: string | null }>;
    /** Record a request to reopen a Plan review while the Session is busy. */
    recordBusyPlanReview?(sessionId: string): Promise<void>;
}

/** Host readiness and user model selection used for ACP session configuration. */
export interface AcpServerModelHost {
    /** Whether a new Session can use the host's selected default model. */
    isReady(cwd: string): boolean;
    /** List the models selectable by the ACP client. */
    list(): Promise<readonly AcpModelOption[]>;
    /** Select a model for this Session. */
    select(sessionId: string, model: string, provider: string): Promise<{ ok: boolean; error?: string }>;
}

/** Transport, runtime, and host capabilities for a single ACP connection. */
export interface AcpServerOptions {
    transport: AcpTransport;
    runtime: AcpServerRuntime;
    agentInfo?: InitializeResponse["agentInfo"];
    /** Offer this login command to clients that support terminal authentication. */
    terminalAuth?: Extract<AuthMethod, { type: "terminal" }>;
    commandCatalog?: AcpCommandCatalog;
    commands?: AcpServerCommandHost;
    models?: AcpServerModelHost;
    review?: AcpReviewServices;
    /** Provide structured ACP error data when the host declines to enter a project. */
    describeProjectRefusal?(error: Error): JsonRecord | undefined;
}
