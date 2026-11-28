export interface PrimaryProjectRuntimeLayout {
    checkoutRoot: string;
    internalRoot: string;
    layoutMarkerPath: string;
    layoutMigrationJournalPath: string;
    layoutMigrationLockPath: string;
    controllerPlansDir: string;
    worktreeRegistryPath: string;
    worktreeRegistryLockPath: string;
    worktreeRegistryMigrationIssuesPath: string;
    publicationStagingRoot: string;
    deliveryEvidenceRoot: string;
    projectSecretStorePath: string;
    fallbackWorktreesRoot: string;
    debugRoot: string;
    workRecordIndexDatabasePath: string;
}

export interface SelectedProjectRuntimeLayout {
    checkoutRoot: string;
    internalRoot: string;
    planLocksDir: string;
    planCatalogLockPath: string;
    transitionJournalsDir: string;
    planBackupsDir: string;
    validationLogsDir: string;
    workRecordSupersessionLockPath: string;
    workRecordSupersessionRecoveryLockPath: string;
}

export interface ProjectRuntimeLayout {
    primary: PrimaryProjectRuntimeLayout;
    selected: SelectedProjectRuntimeLayout;
}

/** Use a stable sidecar because replacing the secret document changes its inode. */
export function collaborationSecretStoreLockPath(storePath: string): string {
    return `${storePath}.lock`;
}

export type ProjectRuntimeMigrationBlockedReason =
    | "newer_layout"
    | "malformed_migration_evidence"
    | "authority_conflict"
    | "active_legacy_writer"
    | "malformed_registry"
    | "tracked_runtime"
    | "tracked_secret"
    | "symlink"
    | "invalid_registered_checkout"
    | "unsupported_filesystem_move";

export interface ProjectRuntimeMigrationSecurityAction {
    rotateCapabilities: boolean;
    removeFromRepositoryHistory: boolean;
    message: string;
}

export interface ProjectRuntimeMigrationReadyResult {
    kind: "ready";
    layout: ProjectRuntimeLayout;
    migrated: boolean;
    adoptedSelectedCheckoutRoots: string[];
}

export interface ProjectRuntimeMigrationBlockedResult {
    kind: "blocked";
    reason: ProjectRuntimeMigrationBlockedReason;
    paths: string[];
    message: string;
    securityAction?: ProjectRuntimeMigrationSecurityAction;
}

export type ProjectRuntimeMigrationResult = ProjectRuntimeMigrationReadyResult | ProjectRuntimeMigrationBlockedResult;

export interface ProjectRuntimeLayoutAdoptedInspection {
    kind: "adopted";
    layout: ProjectRuntimeLayout;
    adoptedSelectedCheckoutRoots: string[];
}

export interface ProjectRuntimeLayoutPendingInspection {
    kind: "pending";
    layout: ProjectRuntimeLayout;
    selectedCheckoutRoots: string[];
}

export type ProjectRuntimeLayoutInspection =
    | ProjectRuntimeLayoutAdoptedInspection
    | ProjectRuntimeLayoutPendingInspection
    | ProjectRuntimeMigrationBlockedResult;

export class ProjectRuntimeEntryRefusedError extends Error {
    reason: ProjectRuntimeMigrationBlockedReason;
    paths: string[];
    securityAction?: ProjectRuntimeMigrationSecurityAction;

    constructor(refusal: ProjectRuntimeMigrationBlockedResult) {
        super(refusal.paths.length > 0 ? `${refusal.message} Paths: ${refusal.paths.join(", ")}` : refusal.message);
        this.name = "ProjectRuntimeEntryRefusedError";
        this.reason = refusal.reason;
        this.paths = refusal.paths;
        if (refusal.securityAction) this.securityAction = refusal.securityAction;
    }
}

export interface ProjectRuntimeReadAccess {
    kind: "ready" | "fresh" | "pending";
    layout: ProjectRuntimeLayout;
    adoptedSelectedCheckoutRoots?: string[];
}

export type ProjectRuntimeReadInspection = ProjectRuntimeReadAccess | ProjectRuntimeMigrationBlockedResult;
