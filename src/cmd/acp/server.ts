import type { AcpTransport } from "@runwield/acp";
import { connectAcpServer } from "@runwield/acp";
import type { AgentConnection } from "@agentclientprotocol/sdk/unstable";
import { createInteractiveSessionRuntime, type InteractiveSessionRuntime } from "@runwield/session-runtime/services";
import { getCommandDefinition, getSlashCommandDefinitions } from "../registry.ts";
import { ProjectRuntimeEntryRefusedError } from "../../shared/project-runtime-layout.ts";
import { VERSION } from "../../shared/version.js";
import { startBrowserQuestionServer } from "../../shared/session/browser-question.ts";
import { openFileSessionStore } from "../../shared/session/file-session-store.ts";
import type { FileSessionStore } from "../../shared/session/file-session-store-types.ts";
import { requestLocalReviewInteraction } from "../../shared/session/local-review-interactions.ts";
import { getSelectedDefaultModelAvailability } from "../../shared/session/model-readiness.ts";
import { applyUserModelSelection, listUserModelOptions } from "../../shared/session/user-selection.ts";
import { createAcpCommandHost } from "./commands.ts";

interface LocalAcpServerOptions {
    diagnostic?: (message: string) => void | Promise<void>;
}

async function closeLocalResources(runtime: InteractiveSessionRuntime, store: FileSessionStore): Promise<void> {
    try {
        await runtime.closeAllSessionsWhenIdle();
    } finally {
        store.close();
    }
}

/** Start ACP with the CLI's local Session Runtime, commands, and Session store. */
export function startRunWieldAcpServer(transport: AcpTransport, options: LocalAcpServerOptions = {}): AgentConnection {
    const sessionStore = openFileSessionStore();
    let runtime: InteractiveSessionRuntime;
    try {
        runtime = createInteractiveSessionRuntime({ sessionStore, ownerProcessKind: "acp" });
    } catch (error) {
        sessionStore.close();
        throw error;
    }

    let connection: AgentConnection;
    try {
        connection = connectAcpServer({
            transport,
            runtime,
            agentInfo: { name: "RunWield", version: VERSION },
            terminalAuth: {
                id: "runwield-terminal-login",
                name: "RunWield Login",
                description: "Open a terminal to configure RunWield credentials and choose a default model.",
                type: "terminal",
                args: ["login"],
            },
            commandCatalog: {
                listBuiltins: () => getSlashCommandDefinitions("acp"),
                isReserved: (name) => Boolean(getCommandDefinition(name)),
            },
            commands: createAcpCommandHost(runtime),
            models: {
                isReady: (cwd) => getSelectedDefaultModelAvailability(cwd).available,
                list: listUserModelOptions,
                select: (sessionId, model, provider) => applyUserModelSelection(runtime, sessionId, model, provider),
            },
            review: { startBrowserQuestionServer, requestLocalReviewInteraction },
            describeProjectRefusal(error) {
                if (!(error instanceof ProjectRuntimeEntryRefusedError)) return undefined;
                return {
                    reason: error.reason,
                    paths: error.paths,
                    ...(error.securityAction ? { securityAction: { ...error.securityAction } } : {}),
                };
            },
        });
    } catch (error) {
        void closeLocalResources(runtime, sessionStore).catch(() => {});
        throw error;
    }
    const closed = connection.closed.finally(() => closeLocalResources(runtime, sessionStore));
    try {
        const diagnostic = options.diagnostic?.("RunWield ACP stdio server started");
        if (diagnostic) void diagnostic.catch((error) => connection.close(error));
    } catch (error) {
        connection.close(error);
        void closed.catch(() => {});
        throw error;
    }
    return { ...connection, closed };
}
