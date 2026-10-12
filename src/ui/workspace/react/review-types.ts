export type PlanExecutionAgent = "engineer" | "frontend-engineer";
export type PlanCollaborationRecommendation = "autonomous" | "pair";

export type PlanReviewOptions = {
    plan: string;
    token: string;
    planPath?: string;
    previousPlan?: string;
    planVersions?: Array<{ plan: string; timestamp: string }>;
    mode: "workflow" | "dev";
    classification?: "QUICK_FIX" | "FEATURE" | "PROJECT";
    frontmatter?: Record<string, unknown>;
    executionPolicy?: {
        executionAgent: PlanExecutionAgent;
        collaborationRecommendation: PlanCollaborationRecommendation;
        source?: string;
    };
    imageBaseDir?: string;
};

export type PlanReviewCodeAnnotation = {
    id: string;
    filePath: string;
    lineStart: number;
    lineEnd: number;
    text?: string;
    originalCode?: string;
    createdAt: number;
};

export type ArtifactReadOptions = {
    surface: "artifact-read";
    markdown: string;
    token: string;
    artifactKind:
        | "plan"
        | "prd"
        | "adr"
        | "work-record"
        | "epic-artifact"
        | "report"
        | "design-system"
        | "domain-language"
        | "document";
    title: string;
    artifactPath?: string;
    notices?: string[];
    sourceLinks?: Array<{ label: string; href: string }>;
    mode: "workflow" | "dev";
    launch?: "standalone" | "session" | "project" | "linked";
    imageBaseDir?: string;
    returnHref?: string;
    returnLabel?: string;
};

export type CodeReviewOptions = {
    rawPatch: string;
    gitRef: string;
    agentCwd: string;
    planName?: string;
    planTitle?: string;
    token: string;
    reviewStatus?: {
        stagedFiles: string[];
        unstagedFiles: string[];
        untrackedFiles: string[];
    };
    mode: "workflow" | "dev";
};

export type PlanReviewDecision = {
    approved: boolean;
    feedback?: string;
    annotations?: unknown[];
    codeAnnotations?: PlanReviewCodeAnnotation[];
    plan?: string;
    savedPath?: string;
    approvalAction?: "run" | "decompose" | "later";
    executionAgent?: PlanExecutionAgent;
    collaborationRecommendation?: PlanCollaborationRecommendation;
    planAttrs?: Record<string, unknown>;
    exit?: boolean;
    agentSwitch?: string;
    permissionMode?: string;
};

export type CodeReviewAnnotation = {
    id: string;
    filePath: string;
    line: number;
    side: string;
    comment: string;
};

export type CodeReviewDecision = {
    approved: boolean;
    feedback: string;
    annotations: CodeReviewAnnotation[];
    images?: Array<{ path: string; name: string }>;
    exit?: boolean;
    canceled?: boolean;
    agentSwitch?: string;
};

export type ReviewSurfaceResult = {
    url: string;
    waitForDecision: () => Promise<unknown>;
    stop: () => void | Promise<void>;
};
