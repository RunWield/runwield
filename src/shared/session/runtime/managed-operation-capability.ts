type ActivationProof = import("../../owner-coordination/session-activations.js").ActivationProof;
type FileSessionStore = import("../file-session-store-types.ts").FileSessionStore;
interface ManagedOperationCapabilityOptions {
    runtimeSessionId: string;
    runwieldSessionId: string;
    operationId: string;
    proof: ActivationProof;
    sessionStore: FileSessionStore;
}

export class ManagedOperationCapability {
    readonly runtimeSessionId: string;
    readonly runwieldSessionId: string;
    readonly operationId: string;

    constructor(options: ManagedOperationCapabilityOptions) {
        this.runtimeSessionId = options.runtimeSessionId;
        this.runwieldSessionId = options.runwieldSessionId;
        this.operationId = options.operationId;
        this.#proof = options.proof;
        this.#sessionStore = options.sessionStore;
    }

    #proof: ActivationProof;
    readonly #sessionStore: FileSessionStore;
    #settled = false;
    readonly #abortController = new AbortController();

    get proof() {
        return this.#proof;
    }

    get settled() {
        return this.#settled;
    }

    get signal() {
        return this.#abortController.signal;
    }

    cancel() {
        this.assertLive();
        this.#abortController.abort();
    }

    registerArtifact(options: import(".././file-session-store-types.ts").RegisterSessionArtifactOptions) {
        this.assertLive();
        return this.#sessionStore.registerSessionArtifact(this.#proof, options);
    }

    recordLastPlanReview(
        review: Pick<
            import("../file-session-store-types.ts").LastPlanReviewReference,
            "planId" | "planName" | "planningAgentName"
        >,
    ) {
        this.assertLive();
        return this.#sessionStore.recordLastPlanReview(this.#proof, review);
    }

    stagePlanAssociation(entry: import(".././file-session-store-types.ts").PlanAssociation) {
        this.assertLive();
        return this.#sessionStore.stagePlanAssociation(this.#proof, entry);
    }

    getCurrentSegmentKind() {
        this.assertLive();
        return this.#sessionStore.getCurrentSessionSegment(this.runwieldSessionId)?.kind || "session";
    }

    updateProof(proof: ActivationProof) {
        this.assertLive();
        if (proof.runwieldSessionId !== this.runwieldSessionId || proof.operationId !== this.operationId) {
            throw new Error("Managed operation proof does not match capability");
        }
        this.#proof = proof;
    }

    assertLive() {
        if (this.#settled) throw new Error("Managed operation capability is settled");
    }

    settle() {
        this.#settled = true;
    }
}
