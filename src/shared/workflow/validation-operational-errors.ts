export type ValidationRecoveryClass = "transient" | "correctable" | "missing_information" | "fatal";

export type ValidationOperation =
    | "local_ci"
    | "semantic_review"
    | "publication"
    | "validation_state"
    | "worktree"
    | "agent_session";

export type ValidationRetryMetadata = {
    retryAfterMs?: number;
    idempotent: boolean;
};

export type ValidationCorrectionMetadata = {
    field?: string;
    required: string;
};

export type ValidationOperationalFailure = {
    code: string;
    message: string;
    operation: ValidationOperation;
    recoveryClass: ValidationRecoveryClass;
    retry?: ValidationRetryMetadata;
    correction?: ValidationCorrectionMetadata;
    userAction?: string;
};

export type ProviderErrorKind =
    | "rate_limited"
    | "timeout"
    | "network"
    | "service_unavailable"
    | "authentication"
    | "permission_denied"
    | "legacy_text";

export type ProviderOperationalError = {
    source: "provider";
    kind: ProviderErrorKind;
    operation: ValidationOperation;
    message: string;
    code?: string;
    retryAfter?: string | number | Date;
};

export type LocalProcessErrorKind =
    | "command_missing"
    | "process_start_failed"
    | "supervision_failed";

export type LocalProcessOperationalError = {
    source: "local_process";
    kind: LocalProcessErrorKind;
    operation: "local_ci";
    message: string;
};

export type ValidationStateErrorKind =
    | "plan_missing"
    | "worktree_record_missing"
    | "publication_record_missing"
    | "unknown_plan_status";

export type ValidationStateOperationalError = {
    source: "validation_state";
    kind: ValidationStateErrorKind;
    operation: ValidationOperation;
    message: string;
};

export type WorktreeErrorKind = "worktree_missing" | "repair_checkout_missing" | "primary_checkout_dirty";

export type WorktreeOperationalError = {
    source: "worktree";
    kind: WorktreeErrorKind;
    operation: ValidationOperation;
    message: string;
};

export type GitPublicationErrorKind =
    | "target_reference_race"
    | "remote_unavailable"
    | "content_conflict"
    | "primary_checkout_dirty"
    | "permission_denied"
    | "policy_violation"
    | "post_publication_bookkeeping";

export type GitPublicationOperationalError = {
    source: "git_publication";
    kind: GitPublicationErrorKind;
    operation: "publication";
    message: string;
};

export type ReviewerProtocolErrorKind =
    | "missing_review_complete"
    | "diff_not_read"
    | "unaccounted_findings"
    | "invalid_tool_arguments"
    | "missing_optional_entity";

export type ReviewerProtocolOperationalError = {
    source: "reviewer_protocol";
    kind: ReviewerProtocolErrorKind;
    operation: "semantic_review" | "agent_session";
    message: string;
    field?: string;
    required: string;
};

export type PolicyOperationalError = {
    source: "policy";
    kind: "prohibited" | "lifecycle_invariant" | "access_unavailable";
    operation: ValidationOperation;
    message: string;
    userAction?: string;
};

export type ValidationOperationalErrorSource =
    | ProviderOperationalError
    | LocalProcessOperationalError
    | ValidationStateOperationalError
    | WorktreeOperationalError
    | GitPublicationOperationalError
    | ReviewerProtocolOperationalError
    | PolicyOperationalError;

export const VALIDATION_RETRY_AFTER_MAX_MS = 60_000;
export const OPERATIONAL_MESSAGE_MAX_LENGTH = 500;

export function sanitizeOperationalMessage(message: string): string {
    const cleaned = message.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    return cleaned.length > OPERATIONAL_MESSAGE_MAX_LENGTH
        ? `${cleaned.slice(0, OPERATIONAL_MESSAGE_MAX_LENGTH - 1)}…`
        : cleaned;
}

export function parseBoundedRetryAfterMs(
    retryAfter: string | number | Date | undefined,
    maxDelayMs: number,
): number | undefined {
    if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) return undefined;
    let valueMs: number;
    if (typeof retryAfter === "number") {
        valueMs = retryAfter * 1000;
    } else if (retryAfter instanceof Date) {
        valueMs = retryAfter.getTime() - Date.now();
    } else if (typeof retryAfter === "string") {
        const trimmed = retryAfter.trim();
        const seconds = Number(trimmed);
        valueMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(trimmed) - Date.now();
    } else {
        return undefined;
    }
    if (!Number.isFinite(valueMs) || valueMs <= 0 || valueMs > maxDelayMs) return undefined;
    return Math.ceil(valueMs);
}

function transientFailure(
    source: ProviderOperationalError | GitPublicationOperationalError,
): ValidationOperationalFailure {
    return {
        code: "code" in source && typeof source.code === "string" && source.code
            ? source.code
            : `${source.source}/${source.kind}`,
        message: sanitizeOperationalMessage(source.message),
        operation: source.operation,
        recoveryClass: "transient",
        retry: {
            idempotent: true,
            retryAfterMs: "retryAfter" in source
                ? parseBoundedRetryAfterMs(source.retryAfter, VALIDATION_RETRY_AFTER_MAX_MS)
                : undefined,
        },
    };
}

function localProcessFailure(source: LocalProcessOperationalError): ValidationOperationalFailure {
    return {
        code: `${source.source}/${source.kind}`,
        message: sanitizeOperationalMessage(source.message),
        operation: source.operation,
        recoveryClass: "missing_information",
        userAction: source.kind === "command_missing"
            ? "Set a validation command for this project."
            : "Fix the local environment, then retry validation.",
    };
}

function providerCode(source: ProviderOperationalError, fallback: string): string {
    return typeof source.code === "string" && source.code ? source.code : fallback;
}

function assertNever(value: never): never {
    throw new Error(`Unhandled validation operational error source: ${String(value)}`);
}

export function classifyValidationOperationalError(
    source: ValidationOperationalErrorSource,
): ValidationOperationalFailure {
    switch (source.source) {
        case "provider":
            switch (source.kind) {
                case "rate_limited":
                case "timeout":
                case "network":
                case "service_unavailable":
                    return transientFailure(source);
                case "authentication":
                    return {
                        code: providerCode(source, "provider/authentication"),
                        message: sanitizeOperationalMessage(source.message),
                        operation: source.operation,
                        recoveryClass: "missing_information",
                        userAction: "Restore provider authentication, then retry validation.",
                    };
                case "permission_denied":
                    return {
                        code: providerCode(source, "provider/permission_denied"),
                        message: sanitizeOperationalMessage(source.message),
                        operation: source.operation,
                        recoveryClass: "fatal",
                        userAction: "Grant access or choose an available provider.",
                    };
                case "legacy_text":
                    return {
                        code: providerCode(source, "provider/legacy_unclassified"),
                        message: sanitizeOperationalMessage(source.message),
                        operation: source.operation,
                        recoveryClass: "fatal",
                        userAction: "Check the provider error and retry after fixing it.",
                    };
                default:
                    return assertNever(source);
            }
            // eslint-disable-next-line no-unreachable -- Deno requires this exhaustive-switch guard.
            break;
        case "local_process":
            switch (source.kind) {
                case "command_missing":
                case "process_start_failed":
                case "supervision_failed":
                    return localProcessFailure(source);
                default:
                    return assertNever(source);
            }
            // eslint-disable-next-line no-unreachable -- Deno requires this exhaustive-switch guard.
            break;
        case "validation_state":
            switch (source.kind) {
                case "plan_missing":
                case "worktree_record_missing":
                case "publication_record_missing":
                    return {
                        code: `${source.source}/${source.kind}`,
                        message: sanitizeOperationalMessage(source.message),
                        operation: source.operation,
                        recoveryClass: "missing_information",
                        userAction: "Restore the missing RunWield state, then retry validation.",
                    };
                case "unknown_plan_status":
                    return {
                        code: "validation_state/unknown_plan_status",
                        message: sanitizeOperationalMessage(source.message),
                        operation: source.operation,
                        recoveryClass: "fatal",
                    };
                default:
                    return assertNever(source);
            }
            // eslint-disable-next-line no-unreachable -- Deno requires this exhaustive-switch guard.
            break;
        case "worktree":
            switch (source.kind) {
                case "worktree_missing":
                case "repair_checkout_missing":
                    return {
                        code: `${source.source}/${source.kind}`,
                        message: sanitizeOperationalMessage(source.message),
                        operation: source.operation,
                        recoveryClass: "missing_information",
                        userAction: "Restore the missing checkout, then retry validation.",
                    };
                case "primary_checkout_dirty":
                    return {
                        code: "worktree/primary_checkout_dirty",
                        message: sanitizeOperationalMessage(source.message),
                        operation: source.operation,
                        recoveryClass: "missing_information",
                        userAction: "Commit, stash, or remove the primary checkout changes, then retry.",
                    };
                default:
                    return assertNever(source);
            }
            // eslint-disable-next-line no-unreachable -- Deno requires this exhaustive-switch guard.
            break;
        case "git_publication":
            switch (source.kind) {
                case "target_reference_race":
                case "remote_unavailable":
                    return transientFailure(source);
                case "content_conflict":
                    return {
                        code: "git_publication/content_conflict",
                        message: sanitizeOperationalMessage(source.message),
                        operation: source.operation,
                        recoveryClass: "correctable",
                        correction: { required: "Repair the proven merge conflict in the merge worktree." },
                    };
                case "primary_checkout_dirty":
                    return {
                        code: "git_publication/primary_checkout_dirty",
                        message: sanitizeOperationalMessage(source.message),
                        operation: source.operation,
                        recoveryClass: "missing_information",
                        userAction: "Clean or save primary checkout changes, then retry publication.",
                    };
                case "permission_denied":
                    return {
                        code: `${source.source}/${source.kind}`,
                        message: sanitizeOperationalMessage(source.message),
                        operation: source.operation,
                        recoveryClass: "fatal",
                        userAction: "Restore Git credentials or upstream write access, then load this Plan and retry.",
                    };
                case "policy_violation":
                    return {
                        code: `${source.source}/${source.kind}`,
                        message: sanitizeOperationalMessage(source.message),
                        operation: source.operation,
                        recoveryClass: "fatal",
                        userAction: "Resolve the branch rule Git reported, then load this Plan and retry.",
                    };
                case "post_publication_bookkeeping":
                    return {
                        code: "git_publication/post_publication_bookkeeping",
                        message: sanitizeOperationalMessage(source.message),
                        operation: source.operation,
                        recoveryClass: "missing_information",
                        userAction: "Run validation again so RunWield can verify publication state.",
                    };
                default:
                    return assertNever(source);
            }
            // eslint-disable-next-line no-unreachable -- Deno requires this exhaustive-switch guard.
            break;
        case "reviewer_protocol":
            switch (source.kind) {
                case "missing_review_complete":
                case "diff_not_read":
                case "unaccounted_findings":
                case "invalid_tool_arguments":
                    return {
                        code: `${source.source}/${source.kind}`,
                        message: sanitizeOperationalMessage(source.message),
                        operation: source.operation,
                        recoveryClass: "correctable",
                        correction: { field: source.field, required: source.required },
                    };
                case "missing_optional_entity":
                    return {
                        code: "reviewer_protocol/missing_optional_entity",
                        message: sanitizeOperationalMessage(source.message),
                        operation: source.operation,
                        recoveryClass: "missing_information",
                        correction: { field: source.field, required: source.required },
                    };
                default:
                    return assertNever(source);
            }
            // eslint-disable-next-line no-unreachable -- Deno requires this exhaustive-switch guard.
            break;
        case "policy":
            switch (source.kind) {
                case "prohibited":
                case "lifecycle_invariant":
                case "access_unavailable":
                    return {
                        code: `policy/${source.kind}`,
                        message: sanitizeOperationalMessage(source.message),
                        operation: source.operation,
                        recoveryClass: "fatal",
                        userAction: source.userAction,
                    };
                default:
                    return assertNever(source);
            }
            // eslint-disable-next-line no-unreachable -- Deno requires this exhaustive-switch guard.
            break;
        default:
            return assertNever(source);
    }
}
