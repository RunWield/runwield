import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { withRuntimeCommandFixture, type RuntimeCommandFixture } from "../../../cmd/testing/runtime-command-fixture.ts";
import { openOwnerCoordinationStore } from "../../../shared/owner-coordination/index.ts";
import type {
    RuntimeInteractionRequest,
    RuntimeInteractionResult,
} from "../../../shared/session/session-runtime-interactions.ts";
import { WorkspaceSessionContinuationService } from "../server/session-continuation.js";
import { createOwnerWorkspaceApp } from "../server.js";

interface LiveInteractionReference {
    projectId: string;
    runwieldSessionId: string;
    operationId: string;
    interactionId: string;
}

interface LiveInteractionFixture {
    service: WorkspaceSessionContinuationService;
    store: ReturnType<typeof openOwnerCoordinationStore>;
    reference: LiveInteractionReference;
    root: string;
    app: ReturnType<typeof createOwnerWorkspaceApp>;
    origin: string;
    cookie: string;
    csrf: string;
    response: Promise<RuntimeInteractionResult>;
    settle(): Promise<void>;
}

interface PreparedInteractionSession {
    runwieldSessionId: string;
    expectedGeneration: number;
}

/** Keep the provider turn pending while a real Workspace-owned Session requests review. */
export async function withLiveWorkspaceInteraction(
    request: RuntimeInteractionRequest,
    check: (fixture: LiveInteractionFixture) => Promise<void>,
    root?: string,
) {
    await withRuntimeCommandFixture("workspace-live-interaction-", async (fixture) => {
        await withExistingRuntimeInteraction(fixture, request, check, root);
    });
}

/** Use inside an existing runtime fixture, which already owns the process-global lock. */
export async function withExistingRuntimeInteraction(
    { projectRoot, setModelResponseFactory }: RuntimeCommandFixture,
    request: RuntimeInteractionRequest,
    check: (fixture: LiveInteractionFixture) => Promise<void>,
    root?: string,
    prepareSession?: (service: WorkspaceSessionContinuationService) => Promise<PreparedInteractionSession>,
) {
    const store = openOwnerCoordinationStore();
    const project = store.registerProject({ root: root || projectRoot });
    const origin = "http://127.0.0.1:8787";
    const app = createOwnerWorkspaceApp({ mode: "owner", publicOrigin: origin, store });
    const service = app.sessionContinuation;
    const pairing = store.createPairingRequest();
    store.approvePairingRequest(pairing.code);
    const device = store.claimPairingRequest(pairing.proof);
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    setModelResponseFactory(async (_context, options) => {
        options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
        entered.resolve();
        await release.promise;
        if (options?.signal?.aborted) throw new DOMException("Canceled provider turn", "AbortError");
        return fauxAssistantMessage(fauxText("Review fixture finished."));
    });
    let pending:
        Promise<import("../../../shared/session/session-runtime-interactions.ts").RuntimeInteractionResult> | undefined;
    try {
        const prepared = await prepareSession?.(service);
        const started = prepared
            ? await service.startContinuation({
                  projectId: project.projectId,
                  requestId: "fixture-turn",
                  text: "Review the current changes.",
                  ...prepared,
              })
            : await service.createSession({
                  projectId: project.projectId,
                  requestId: "fixture-turn",
                  text: "Review the current changes.",
                  agentName: "operator",
              });
        await entered.promise;
        const runtimeSession = service.runtime.listSessions()[0];
        const operation = service.getOperation(started.operationId);
        if (!runtimeSession || !operation.runwieldSessionId) throw new Error("Workspace Session was not created");
        pending = service.runtime.requestInteraction(runtimeSession.id, request);
        let interactionFailure = "";
        void pending.catch((error) => {
            interactionFailure = String(error);
        }); // Callers assert expected stale-review rejections.
        let live = service.getOperation(started.operationId).liveInteraction;
        for (let attempt = 0; attempt < 200 && !live; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            live = service.getOperation(started.operationId).liveInteraction;
        }
        if (!live)
            throw new Error(
                `Workspace ${request.type} interaction was not published: ${interactionFailure}; ${JSON.stringify(service.getOperation(started.operationId))}`,
            );
        const reference = {
            projectId: project.projectId,
            runwieldSessionId: operation.runwieldSessionId,
            operationId: started.operationId,
            interactionId: live.interactionId,
        };
        await check({
            service,
            store,
            root: root || projectRoot,
            reference,
            app,
            origin,
            cookie: `rw_owner_device=${encodeURIComponent(device.credential)}; rw_owner_csrf=${encodeURIComponent(device.csrf)}`,
            csrf: device.csrf,
            response: pending,
            async settle() {
                await service.answerInteraction({
                    ...reference,
                    requestId: "fixture-answer",
                    response: { outcome: "canceled" },
                });
                await pending;
            },
        });
    } finally {
        release.resolve();
        await app.close();
        await pending?.catch(() => {});
        store.close();
    }
}
