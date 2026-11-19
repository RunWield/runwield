/** Typed outcomes for validation operations that did not reach a terminal Plan state. */

import type { JsonValue } from "../jsonc.ts";
import { getCustomSetting } from "../settings.ts";
import { recordMetric } from "./validation-context.ts";
import type { ValidationLoopArgs } from "./validation-types.ts";
import type { ValidationOperationalFailure, ValidationRecoveryClass } from "./validation-operational-errors.ts";

export type ValidationRecoveryKind =
    | "reconcile_and_retry"
    | "retry_later"
    | "agent_correction"
    | "user_action"
    | "terminal";

export type ValidationRecoveryAction = "retry_now" | "retry_later" | "correct_agent_output" | "choose" | "none";

export type ValidationRecoveryResult = {
    kind: ValidationRecoveryKind;
    code: string;
    message: string;
    action: ValidationRecoveryAction;
    nextPhase?: "mechanical" | "semantic" | "delivery";
    operation?: string;
    recoveryClass?: ValidationRecoveryClass;
    attempt?: number;
    maxAttempts?: number;
    delayMs?: number;
};

export type ValidationRetryPolicy = {
    enabled: boolean;
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
};

export type ValidationRecoveryDecision =
    | { action: "retry"; result: ValidationRecoveryResult; delayMs: number }
    | { action: "correct"; result: ValidationRecoveryResult }
    | { action: "pause"; result: ValidationRecoveryResult }
    | { action: "halt"; result: ValidationRecoveryResult };

export const DEFAULT_VALIDATION_RETRY_POLICY: ValidationRetryPolicy = Object.freeze({
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2_000,
    maxDelayMs: 60_000,
});

export const VALIDATION_PROTOCOL_CORRECTION_LIMIT = 3;

export function retryValidationLater(
    code: string,
    message: string,
    nextPhase?: ValidationRecoveryResult["nextPhase"],
): ValidationRecoveryResult {
    return { kind: "retry_later", code, message, action: "retry_later", ...(nextPhase ? { nextPhase } : {}) };
}

export function validationNeedsUserChoice(code: string, message: string): ValidationRecoveryResult {
    return { kind: "user_action", code, message, action: "choose" };
}

function positiveNumber(value: JsonValue | undefined, fallback: number): number {
    const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function nonNegativeNumber(value: JsonValue | undefined, fallback: number): number {
    const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : fallback;
}

export function readValidationRetryPolicy(projectRoot: string): ValidationRetryPolicy {
    const enabled = getCustomSetting("retry.enabled", "project", projectRoot);
    return {
        enabled: typeof enabled === "boolean" ? enabled : DEFAULT_VALIDATION_RETRY_POLICY.enabled,
        maxRetries: Math.floor(
            nonNegativeNumber(
                getCustomSetting("retry.maxRetries", "project", projectRoot),
                DEFAULT_VALIDATION_RETRY_POLICY.maxRetries,
            ),
        ),
        baseDelayMs: positiveNumber(
            getCustomSetting("retry.baseDelayMs", "project", projectRoot),
            DEFAULT_VALIDATION_RETRY_POLICY.baseDelayMs,
        ),
        maxDelayMs: positiveNumber(
            getCustomSetting("retry.validation.maxDelayMs", "project", projectRoot),
            DEFAULT_VALIDATION_RETRY_POLICY.maxDelayMs,
        ),
    };
}

export function calculateValidationRetryDelayMs(args: {
    retryIndex: number;
    baseDelayMs: number;
    maxDelayMs: number;
    randomUnit: number;
    retryAfterMs?: number;
}): number {
    if (typeof args.retryAfterMs === "number" && args.retryAfterMs > 0 && args.retryAfterMs <= args.maxDelayMs) {
        return Math.ceil(args.retryAfterMs);
    }
    const boundedRandom = Math.min(1, Math.max(0, args.randomUnit));
    const cap = Math.min(args.maxDelayMs, args.baseDelayMs * 2 ** Math.max(0, args.retryIndex));
    return Math.floor(boundedRandom * cap);
}

function randomUnitFromCrypto(): number {
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    return bytes[0] / 0xffffffff;
}

export function decideValidationRecovery(args: {
    failure: ValidationOperationalFailure;
    attempt: number;
    correctionAttempt?: number;
    policy: ValidationRetryPolicy;
    nextPhase?: ValidationRecoveryResult["nextPhase"];
    randomUnit?: number;
}): ValidationRecoveryDecision {
    const base = {
        code: args.failure.code,
        operation: args.failure.operation,
        recoveryClass: args.failure.recoveryClass,
        attempt: args.attempt,
        nextPhase: args.nextPhase,
    };
    switch (args.failure.recoveryClass) {
        case "transient": {
            if (!args.policy.enabled || args.attempt >= args.policy.maxRetries) {
                return {
                    action: "pause",
                    result: {
                        ...base,
                        kind: "retry_later",
                        action: "retry_later",
                        maxAttempts: args.policy.maxRetries,
                        message: `${args.failure.message} Retry budget is spent. Validation is paused at this phase.`,
                    },
                };
            }
            const delayMs = calculateValidationRetryDelayMs({
                retryIndex: args.attempt - 1,
                baseDelayMs: args.policy.baseDelayMs,
                maxDelayMs: args.policy.maxDelayMs,
                randomUnit: args.randomUnit ?? randomUnitFromCrypto(),
                retryAfterMs: args.failure.retry?.retryAfterMs,
            });
            return {
                action: "retry",
                delayMs,
                result: {
                    ...base,
                    kind: delayMs > 0 ? "retry_later" : "reconcile_and_retry",
                    action: delayMs > 0 ? "retry_later" : "retry_now",
                    maxAttempts: args.policy.maxRetries,
                    delayMs,
                    message:
                        `${args.failure.message} Retrying ${args.failure.operation} (${args.attempt}/${args.policy.maxRetries}) in ${delayMs}ms.`,
                },
            };
        }
        case "correctable": {
            const correctionAttempt = args.correctionAttempt ?? args.attempt;
            if (correctionAttempt > VALIDATION_PROTOCOL_CORRECTION_LIMIT) {
                return {
                    action: "pause",
                    result: {
                        ...base,
                        kind: "retry_later",
                        action: "retry_later",
                        maxAttempts: VALIDATION_PROTOCOL_CORRECTION_LIMIT,
                        message:
                            `${args.failure.message} Protocol correction budget is spent. Validation is paused at this phase.`,
                    },
                };
            }
            return {
                action: "correct",
                result: {
                    ...base,
                    kind: "agent_correction",
                    action: "correct_agent_output",
                    maxAttempts: VALIDATION_PROTOCOL_CORRECTION_LIMIT,
                    message: args.failure.correction?.required || args.failure.message,
                },
            };
        }
        case "missing_information":
            if (args.failure.correction) {
                return {
                    action: "correct",
                    result: {
                        ...base,
                        kind: "agent_correction",
                        action: "correct_agent_output",
                        message: args.failure.correction.required,
                    },
                };
            }
            return {
                action: "pause",
                result: {
                    ...base,
                    kind: "user_action",
                    action: "choose",
                    message: args.failure.userAction
                        ? `${args.failure.message} ${args.failure.userAction}`
                        : args.failure.message,
                },
            };
        case "fatal":
            return {
                action: "halt",
                result: {
                    ...base,
                    kind: "terminal",
                    action: "none",
                    message: args.failure.userAction
                        ? `${args.failure.message} ${args.failure.userAction}`
                        : args.failure.message,
                },
            };
        default: {
            const exhaustive: never = args.failure.recoveryClass;
            return exhaustive;
        }
    }
}

export async function waitForValidationRetry(delayMs: number, signal?: AbortSignal): Promise<"completed" | "canceled"> {
    if (delayMs <= 0) return "completed";
    if (signal?.aborted) return "canceled";
    return await new Promise((resolve) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve("completed");
        }, delayMs);
        const onAbort = () => {
            cleanup();
            resolve("canceled");
        };
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export async function waitForValidationRetryWithSessionCancellation(
    args: ValidationLoopArgs,
    delayMs: number,
    operation: string,
): Promise<"completed" | "canceled"> {
    if (delayMs <= 0) return "completed";
    const abortController = new AbortController();
    const interactionId = `validation-retry:${args.planName}:${operation}:${Date.now()}`;
    args.session.registerActiveInteraction(interactionId, abortController);
    try {
        return await waitForValidationRetry(delayMs, abortController.signal);
    } finally {
        args.session.unregisterActiveInteraction(interactionId);
    }
}

export async function recordOperationalRecoveryMetric(
    args: ValidationLoopArgs,
    projectRoot: string,
    result: ValidationRecoveryResult,
): Promise<void> {
    await recordMetric(args, projectRoot, {
        category: "validation",
        event: "operational_recovery",
        planName: args.planName,
        details: {
            operation: result.operation || "validation_state",
            code: result.code,
            recoveryClass: result.recoveryClass || "fatal",
            attempt: result.attempt || 1,
            action: result.action,
            delayMs: result.delayMs || 0,
        },
    });
}
