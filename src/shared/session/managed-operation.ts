type ManagedTurnStarted = (context: { turnId: string }) => void | (() => void);

export type ManagedOperationName =
    | "prompt"
    | "rename"
    | "switch_agent"
    | "set_model"
    | "set_thinking_level"
    | "reload"
    | "compact"
    | "local_shell"
    | "submit_user_turn"
    | "initialize"
    | "workflow_operation";

export type ManagedOperationDescriptor = {
    name: ManagedOperationName;
    options?: {
        expectedGeneration?: number | null;
        initialRequest?: string;
        generatedTaskId?: string;
        initialImages?: import("./types.js").ImageAttachment[];
        initialTutorialContext?: import("./tutorial-context-session.ts").TutorialContext;
        turnId?: string;
        agentName?: string;
        toolNames?: string[];
        customTools?: import("@earendil-works/pi-coding-agent").ToolDefinition[];
        includeEditFallback?: boolean;
        onTurnStarted?: ManagedTurnStarted;
        emitBusyEvents?: boolean;
    };
    hydrate?: boolean;
    activateAgent?: boolean;
    emitPromptEvents?: boolean;
};

export type ManagedOperationInternalFacade = {
    readonly capability: ManagedOperationCapability;
    getRootSessionManager(): import("@earendil-works/pi-coding-agent").SessionManager | null;
    getRootAgentSession(): import("@earendil-works/pi-coding-agent").AgentSession | null;
};

export type ManagedOperationResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: "refresh_required" | "reconcile_required" | "managed_operation_in_progress";
};

export type ManagedOperationCapability = {
    readonly runtimeSessionId: string;
    readonly runwieldSessionId: string;
    readonly operationId: string;
    readonly settled: boolean;
    readonly signal?: AbortSignal;
    registerArtifact(
        options: import("./file-session-store-types.ts").RegisterSessionArtifactOptions,
    ): import("./file-session-store-types.ts").SessionArtifactReference;
    recordLastPlanReview?(
        review: Pick<
            import("./file-session-store-types.ts").LastPlanReviewReference,
            "planId" | "planName" | "planningAgentName"
        >,
    ): import("./file-session-store-types.ts").LastPlanReviewReference;
    stagePlanAssociation?(
        entry: import("./file-session-store-types.ts").PlanAssociation,
    ): import("./file-session-store-types.ts").ManifestPlanAssociation;
    getCurrentSegmentKind?(): string;
    cancel?(): void;
    assertLive(): void;
    settle(): void;
};
