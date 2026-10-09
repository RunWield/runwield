import { AGENTS } from "../../../constants.js";
import { readPersistedManualModelState, resolveResumeAgentName } from ".././active-agent-session.js";
import { loadAgentDef } from ".././agents.js";
import { resolveModel } from ".././session.js";
import { resolvePromptTemplateSettings } from "../prompt-template-settings.ts";
import { resolveNamedInvocation } from ".././named-invocation.ts";
import { isPathInside, openPersistedRootSession } from ".././root-session.js";
import { sessionDirForRoot } from ".././file-session-storage.ts";
import {
    modelSupportsImageInput,
    persistImageAttachment,
    preflightImageAttachments,
    prepareImagesForModel,
    resolveVisionFallbackModel,
} from ".././image-attachments.ts";
import { getModelRegistry, SYSTEM_MODEL_DISCOVERY_NETWORK } from "../../models/model-registry.ts";

import { getRuntimeRootAgentSession, isRuntimeRootSessionManager, resolvePersistedResumeModel } from "./support.ts";
import type { ManagedOperationFailure, PromptSessionOptions } from "./types.ts";

import type { RuntimeServices } from "./base.ts";
import type { RuntimeManagedOperations } from "./managed-operations.ts";

type RuntimeImageModel = Awaited<ReturnType<typeof resolveModel>>;
type PersistedSessionImage = Awaited<ReturnType<typeof persistImageAttachment>> & {
    ok?: true;
    error?: undefined;
};
interface RuntimeImageAgentSession {
    modelRegistry?: ReturnType<typeof getModelRegistry>;
    model?: RuntimeImageModel;
}

type RuntimeManagedOperationsDependency = Pick<RuntimeManagedOperations, "runManagedOperation">;

export class RuntimeImages {
    private managedOperations!: RuntimeManagedOperationsDependency;

    constructor(private readonly services: RuntimeServices) {}

    connect(
        managedOperations: RuntimeManagedOperationsDependency,
    ) {
        this.managedOperations = managedOperations;
    }
    async persistSessionImage(
        sessionId: string,
        image: import(".././types.js").ImageAttachment,
    ): Promise<PersistedSessionImage | ManagedOperationFailure> {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) throw new Error("SessionRuntime.persistSessionImage: session not found");
        const managed = session.getManagedMetadata?.();
        if (managed && !session.getRootSessionManager?.()) {
            if (!this.services.sessionStore) {
                throw new Error("Cannot persist image attachment: no active session is available.");
            }
            return await this.managedOperations.runManagedOperation(
                sessionId,
                {
                    name: "submit_user_turn",
                    options: { expectedGeneration: managed.generation ?? undefined },
                    activateAgent: false,
                },
                async () => await this.persistSessionImage(sessionId, image),
            );
        }
        return await this.persistActiveSessionImage(session, image);
    }

    async persistActiveSessionImage(
        session: import(".././hosted-session.js").HostedSession,
        image: import(".././types.js").ImageAttachment,
    ) {
        const sessionManager = session.getRootSessionManager();
        if (!isRuntimeRootSessionManager(sessionManager)) {
            throw new Error("Cannot persist image attachment: no active session is available.");
        }
        return await persistImageAttachment(
            image,
            sessionManager,
            session.cwd,
        );
    }

    async preflightSessionImages(sessionId: string, images: import(".././types.js").ImageAttachment[]) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return { ok: false, message: "Runtime session not found." };
        return await this.preflightImagesForAgentSession(session, images, getRuntimeRootAgentSession(session));
    }

    async prepareSteeringInputForAgentSession(
        session: import(".././hosted-session.js").HostedSession,
        text: string,
        images: import(".././types.js").ImageAttachment[],
        agentSession: RuntimeImageAgentSession,
    ) {
        const modelState = session.getActiveModelState();
        const managed = session.getManagedMetadata?.();
        const modelProvider = modelState.provider || managed?.provider || "";
        const modelId = modelState.model || managed?.model || "";
        const modelRegistry = agentSession.modelRegistry || getModelRegistry();
        const activeModel = agentSession.model ||
            (modelProvider && modelId ? modelRegistry.find(modelProvider, modelId) : undefined);
        const modelProviderName = activeModel?.provider;
        const executionBackend = activeModel?.executionBackend;
        if (images.length > 0 && (modelProviderName === "agy-cli" || executionBackend === "agy-cli")) {
            return { ok: false as const, message: "Antigravity CLI sessions do not support image attachments." };
        }
        let fallbackModelRef: string | undefined;
        if (images.length > 0 && !modelSupportsImageInput(activeModel)) {
            try {
                fallbackModelRef = (await resolveVisionFallbackModel(
                    modelRegistry,
                    SYSTEM_MODEL_DISCOVERY_NETWORK,
                    session.cwd,
                ))?.modelRef;
            } catch (error) {
                return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
            }
        }
        return prepareImagesForModel({ text, images, activeModel, fallbackModelRef });
    }

    async preflightImagesForAgentSession(
        session: import(".././hosted-session.js").HostedSession,
        images: import(".././types.js").ImageAttachment[],
        agentSession: RuntimeImageAgentSession | null,
    ) {
        const modelState = session.getActiveModelState();
        const managed = session.getManagedMetadata?.();
        const modelProvider = modelState.provider || managed?.provider || "";
        const modelId = modelState.model || managed?.model || "";
        const modelRegistry = agentSession?.modelRegistry || getModelRegistry();
        const activeModel = agentSession?.model ||
            (modelProvider && modelId ? modelRegistry.find(modelProvider, modelId) : undefined);
        return await this.preflightImagesForModel(session, images, activeModel, modelRegistry);
    }

    modelReference(activeModel: RuntimeImageModel | null | undefined) {
        const model = activeModel || {};
        if (model.provider && model.id) return `${model.provider}/${model.id}`;
        if (model.provider && model.model) return `${model.provider}/${model.model}`;
        return undefined;
    }

    async preflightImagesForModel(
        session: import(".././hosted-session.js").HostedSession,
        images: import(".././types.js").ImageAttachment[],
        activeModel: RuntimeImageModel | null | undefined,
        modelRegistry: ReturnType<typeof getModelRegistry>,
    ) {
        if (!images || images.length === 0) return { ok: true, mode: "none" };
        const modelProvider = (activeModel || {}).provider;
        const executionBackend = (activeModel || {}).executionBackend;
        if (modelProvider === "agy-cli" || executionBackend === "agy-cli") {
            return { ok: false, message: "Antigravity CLI sessions do not support image attachments." };
        }
        let fallbackModelRef;
        if (!modelSupportsImageInput(activeModel)) {
            try {
                fallbackModelRef = (await resolveVisionFallbackModel(
                    modelRegistry,
                    SYSTEM_MODEL_DISCOVERY_NETWORK,
                    session.cwd,
                ))?.modelRef;
            } catch (error) {
                return { ok: false, message: error instanceof Error ? error.message : String(error) };
            }
        }
        return preflightImageAttachments(images, { activeModel, fallbackModelRef });
    }

    async preflightUserTurnImages(sessionId: string, options: PromptSessionOptions) {
        const session = this.services.sessionHost.getSession(sessionId);
        if (!session) return { ok: false, message: "Runtime session not found." };
        const images = options.initialImages || [];
        if (images.length === 0) return { ok: true, mode: "none" };
        const namedInvocation = await resolveNamedInvocation({
            cwd: session.cwd,
            text: options.initialRequest,
            images,
        });
        const activeAgentInfo = session.getActiveAgentInfo?.() || null;
        const agentName = namedInvocation.kind === "prompt_template"
            ? namedInvocation.agentName || options.agentName || activeAgentInfo?.agentName || AGENTS.OPERATOR
            : options.agentName || activeAgentInfo?.agentName || session.getRootAgentName?.() || AGENTS.ROUTER;
        const modelOverride = namedInvocation.kind === "prompt_template"
            ? options.preparedModelOverride || namedInvocation.model
            : options.preparedModelOverride || options.modelOverride;
        const ignoreManualModelOverride = namedInvocation.kind === "prompt_template";
        const agentDef = await loadAgentDef(agentName, session.cwd);
        const modelRegistry = getModelRegistry();
        const currentSessionManager = session.getRootSessionManager?.();
        let sessionManager: import("./support.ts").RuntimeRootSessionManager | null =
            isRuntimeRootSessionManager(currentSessionManager) ? currentSessionManager : null;
        let openedSessionManager: import("@earendil-works/pi-coding-agent").SessionManager | null = null;
        try {
            if (!sessionManager) {
                const managed = session.getManagedMetadata?.();
                if (managed?.transcriptPath && managed?.piSessionId) {
                    const segment = this.services.sessionStore?.getCurrentSessionSegment(managed.runwieldSessionId);
                    const transcriptPath = segment?.transcriptPath || managed.transcriptPath;
                    const transcriptCwd = segment?.transcriptCwd || session.cwd;
                    const projectRoot = segment && this.services.sessionStore
                        ? this.services.sessionStore.requireSessionProjectRoot(managed.projectId)
                        : null;
                    const projectSessionDir = projectRoot && this.services.sessionStore
                        ? sessionDirForRoot(this.services.sessionStore.path, projectRoot)
                        : null;
                    const managedProjectSessionDir =
                        projectSessionDir && isPathInside(transcriptPath, projectSessionDir)
                            ? projectSessionDir
                            : undefined;
                    const opened = await openPersistedRootSession({
                        cwd: transcriptCwd,
                        sessionId: segment?.piSessionId || managed.piSessionId,
                        sessionPath: transcriptPath,
                        sessionDir: managedProjectSessionDir,
                        managedProjectRoot: managedProjectSessionDir ? projectRoot || undefined : undefined,
                        managedSegmentCwd: managedProjectSessionDir ? transcriptCwd : undefined,
                    });
                    sessionManager = opened.sessionManager;
                    openedSessionManager = opened.sessionManager;
                }
            }
            const templateProfile = namedInvocation.kind === "prompt_template"
                ? await resolvePromptTemplateSettings(session, {
                    ...namedInvocation,
                    model: options.preparedModelOverride || namedInvocation.model,
                }, sessionManager)
                : null;
            let effectiveModelOverride = templateProfile?.model || modelOverride;
            if (!ignoreManualModelOverride && !effectiveModelOverride && sessionManager) {
                const resumeAgent = await resolveResumeAgentName(sessionManager);
                const persistedManualModel = readPersistedManualModelState(sessionManager, agentName || resumeAgent);
                const persistedModel = agentName === resumeAgent
                    ? resolvePersistedResumeModel(sessionManager)
                    : undefined;
                effectiveModelOverride = persistedManualModel
                    ? persistedManualModel.provider
                        ? `${persistedManualModel.provider}/${persistedManualModel.model}`
                        : persistedManualModel.model
                    : persistedModel;
            }
            const activeModel = await resolveModel(
                effectiveModelOverride,
                agentDef,
                templateProfile?.agentName || agentName,
                modelRegistry,
                session,
                session.cwd,
                { ignoreManualModelOverride },
            );
            const result = await this.preflightImagesForModel(session, images, activeModel, modelRegistry);
            return result.ok ? { ...result, preparedModelOverride: this.modelReference(activeModel) } : result;
        } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
        } finally {
            if (isRuntimeRootSessionManager(openedSessionManager)) openedSessionManager.dispose?.();
        }
    }

    async persistPendingPromptImages(
        hostedSession: import(".././hosted-session.js").HostedSession,
        images: import(".././types.js").ImageAttachment[],
    ) {
        if (images.length === 0) return images;
        const sessionManager = hostedSession.getRootSessionManager();
        if (!isRuntimeRootSessionManager(sessionManager)) {
            throw new Error("Cannot persist image attachment: no active session is available.");
        }
        const persisted = [];
        for (const image of images) {
            if (image.path || image.ref) {
                persisted.push(image);
                continue;
            }
            persisted.push(await persistImageAttachment(image, sessionManager, hostedSession.cwd));
        }
        return persisted;
    }
}
