import { loadPlanActionEvidence } from "../../../shared/workflow/plan-actions.ts";
/** @module ui/workspace/routes/owner-api */

import {
    authenticateOwnerRequest,
    clearBootstrapProofCookieHeader,
    clearDeviceCookieHeaders,
    deviceCookieHeaders,
    getCookie,
} from "../server/owner-auth.ts";
import { loadBoard, loadWorkspaceDetail } from "../server/plan-adapter.js";
import { runOwnerPlanAction } from "../server/owner-plan-actions.ts";
import { loadOwnerPlanProgress } from "../server/owner-plan-progress.ts";
import { loadOwnerDashboard, loadOwnerSidebar, subscribeOwnerDashboard } from "../server/owner-dashboard.ts";
import { listOwnerProjects, requireOwnerProjectRoot, serializeOwnerProject } from "../server/owner-projects.ts";
import { ownerSecurityHeaders } from "../server/owner-origin.ts";
import { reviewFileContentApi } from "./api/review-file-handlers.ts";

const MAX_JSON_BYTES = 64 * 1024;

/** @param {unknown} body @param {number} [status] */
export function ownerJson(body, status = 200, headers = new Headers()) {
    ownerSecurityHeaders(headers);
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(body), { status, headers });
}

/** @param {Request} request */
async function readJson(request) {
    const text = await request.text();
    if (text.length > MAX_JSON_BYTES) throw new Error("Request body is too large.");
    return text ? JSON.parse(text) : {};
}

/** @param {unknown} value */
async function requestHash(value) {
    const text = JSON.stringify(value);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** @param {unknown} error */
export function sanitizeOwnerError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/[/\\]|[A-Za-z]:/.test(message)) return "Owner Workspace operation failed.";
    return message;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sanitizeOwnerPlanValue(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(sanitizeOwnerPlanValue);
    /** @type {Record<string, unknown>} */
    const safe = {};
    for (const [key, child] of Object.entries(value)) {
        if (/(path|root|cwd|file)$/i.test(key)) continue;
        safe[key] = sanitizeOwnerPlanValue(child);
    }
    return safe;
}

/** @param {string} value */
function scrubLocalPaths(value) {
    return value
        .replace(/\b[A-Za-z]:[\\/][^\s"'`<>),;]*/g, "[local path]")
        .replace(/(^|[\s("'`=:])\/[A-Za-z0-9._~+\-/]+/g, "$1[local path]");
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sanitizeOwnerDiagnosticValue(value) {
    if (typeof value === "string") return scrubLocalPaths(value);
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(sanitizeOwnerDiagnosticValue);
    /** @type {Record<string, unknown>} */
    const safe = {};
    for (const [key, child] of Object.entries(value)) {
        if (/(path|root|cwd|file)$/i.test(key)) continue;
        safe[key] = sanitizeOwnerDiagnosticValue(child);
    }
    return safe;
}

/**
 * Dashboard links are generated from encoded IDs. Preserve these relative links while
 * scrubbing all free-text fields, including diagnostics and Session prompts.
 * @param {unknown} value
 * @returns {unknown}
 */
function sanitizeOwnerDashboardFrame(value) {
    if (typeof value === "string") return scrubLocalPaths(value);
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(sanitizeOwnerDashboardFrame);
    /** @type {Record<string, unknown>} */
    const safe = {};
    for (const [key, child] of Object.entries(value)) {
        if (/(path|root|cwd|file)$/i.test(key)) continue;
        safe[key] = (key === "href" || key === "repairHref") && typeof child === "string" &&
                (child.startsWith("/projects/") || child === "/")
            ? child
            : sanitizeOwnerDashboardFrame(child);
    }
    return safe;
}

/** @param {unknown} error */
export function ownerErrorJson(error, status = 400) {
    return ownerJson({ error: sanitizeOwnerError(error) }, status);
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function ownerReadOnlyPlanValue(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(ownerReadOnlyPlanValue);
    /** @type {Record<string, unknown>} */
    const readOnly = {};
    for (const [key, child] of Object.entries(value)) {
        if (key === "actions") readOnly[key] = {};
        else if (key === "capabilities" && child && typeof child === "object" && !Array.isArray(child)) {
            readOnly[key] = { ...child, bodyEditing: false };
        } else readOnly[key] = ownerReadOnlyPlanValue(child);
    }
    return readOnly;
}

/** @param {any} ctx */
export async function pairingRequestApi(ctx) {
    try {
        ctx.state.pairingRateLimit?.check(ctx.req);
        const body = await readJson(ctx.req);
        const request = ctx.state.store.createPairingRequest({ deviceLabel: body.deviceLabel || "Browser device" });
        const headers = new Headers();
        headers.append("set-cookie", ctx.state.bootstrapProofCookieHeader(request.proof));
        return ownerJson({ code: request.code, expiresAt: request.expiresAt, state: request.state }, 201, headers);
    } catch (error) {
        return ownerErrorJson(
            error,
            String(error instanceof Error ? error.message : error).startsWith("Too many pairing") ? 429 : 400,
        );
    }
}

/** @param {any} ctx */
export function pairingStatusApi(ctx) {
    const device = authenticateOwnerRequest(ctx.req, ctx.state);
    if (device) return ownerJson({ state: "paired" });
    const proof = getCookie(ctx.req, "rw_pairing_proof");
    if (!proof) return ownerJson({ state: "missing" }, 404);
    const request = ctx.state.store.getPairingRequestByProof(proof);
    if (!request) return ownerJson({ state: "expired" }, 404);
    return ownerJson({ state: request.state, expiresAt: request.expiresAt, deviceLabel: request.deviceLabel });
}

/** @param {any} ctx */
export function pairingClaimApi(ctx) {
    try {
        const proof = getCookie(ctx.req, "rw_pairing_proof");
        if (!proof) throw new Error("Pairing browser proof is missing.");
        const claimed = ctx.state.store.claimPairingRequest(proof);
        const headers = new Headers();
        for (
            const header of deviceCookieHeaders({
                credential: claimed.credential,
                csrf: claimed.csrf,
                publicOrigin: ctx.state.publicOrigin,
            })
        ) headers.append("set-cookie", header);
        headers.append("set-cookie", clearBootstrapProofCookieHeader({ publicOrigin: ctx.state.publicOrigin }));
        return ownerJson({ paired: true, device: claimed.device }, 201, headers);
    } catch (error) {
        return ownerErrorJson(error);
    }
}

/** @param {any} ctx */
export function projectsApi(ctx) {
    return ownerJson({ projects: listOwnerProjects(ctx.state.store) });
}

/** @param {any} ctx */
export async function ownerSidebarApi(ctx) {
    try {
        const projects = await loadOwnerSidebar(ctx.state.store, ctx.state.sessionContinuation);
        return ownerJson({ projects });
    } catch (error) {
        return ownerErrorJson(error);
    }
}

/** @param {any} ctx */
export async function ownerDashboardApi(ctx) {
    try {
        return ownerJson(await loadOwnerDashboard(ctx.state.store, ctx.state.sessionContinuation));
    } catch (error) {
        return ownerErrorJson(error);
    }
}

/** @param {any} ctx */
export function ownerDashboardStreamApi(ctx) {
    const encoder = new TextEncoder();
    /** @type {(() => void) | undefined} */
    let unsubscribe;
    let closed = false;
    const cleanup = () => {
        closed = true;
        unsubscribe?.();
        ctx.req.signal.removeEventListener("abort", cleanup);
    };
    const stream = new ReadableStream({
        start(target) {
            ctx.req.signal.addEventListener("abort", cleanup, { once: true });
            try {
                unsubscribe = subscribeOwnerDashboard(ctx.state.store, ctx.state.sessionContinuation, (frame) => {
                    if (closed) return;
                    // Strip internal fields and redact local paths in every frame, including row text.
                    target.enqueue(encoder.encode(JSON.stringify(sanitizeOwnerDashboardFrame(frame)) + "\n"));
                    if (frame.type === "complete" || frame.type === "error") {
                        cleanup();
                        target.close();
                    }
                });
                if (closed) unsubscribe();
            } catch (error) {
                target.enqueue(
                    encoder.encode(JSON.stringify({ type: "error", error: sanitizeOwnerError(error) }) + "\n"),
                );
                cleanup();
                target.close();
            }
        },
        cancel() {
            cleanup();
        },
    });
    const headers = ownerSecurityHeaders(new Headers());
    headers.set("content-type", "application/x-ndjson; charset=utf-8");
    headers.set("x-accel-buffering", "no");
    return new Response(stream, { headers });
}

/** @param {any} ctx */
export async function ownerWorkspaceSearchApi(ctx) {
    try {
        const input = {
            query: ctx.url.searchParams.get("q") || "",
            projectId: ctx.url.searchParams.get("project") || "",
            contentType: ctx.url.searchParams.get("type") || "",
            page: ctx.url.searchParams.get("page") || "1",
            pageSize: ctx.url.searchParams.get("pageSize") || "20",
        };
        return ownerJson(await ctx.state.workspaceSearch.search(input));
    } catch (error) {
        return ownerErrorJson(error);
    }
}

/** @param {any} ctx */
export async function ownerWorkspaceSearchRefreshApi(ctx) {
    try {
        await ctx.state.workspaceSearch.refresh();
        return ownerJson({ refreshed: true });
    } catch (error) {
        return ownerErrorJson(error);
    }
}

/** @param {any} ctx */
export async function registerProjectApi(ctx) {
    try {
        const body = await readJson(ctx.req);
        if (!body.root) throw new Error("Project root is required.");
        const project = ctx.state.store.registerProject({ root: String(body.root), displayName: body.displayName });
        return ownerJson({
            project: serializeOwnerProject(project, ctx.state.store.getProjectHealth(project.projectId)),
        }, 201);
    } catch (error) {
        return ownerErrorJson(error);
    }
}

/** @param {any} ctx */
export async function projectActionApi(ctx) {
    try {
        const body = await readJson(ctx.req);
        const { projectId } = ctx.params;
        if (body.action === "disable") ctx.state.store.setProjectEnabled(projectId, false);
        else if (body.action === "enable") ctx.state.store.setProjectEnabled(projectId, true);
        else if (body.action === "remove") ctx.state.store.removeProject(projectId);
        else if (body.action === "relink") {
            ctx.state.store.relinkProject({ projectId, newRoot: String(body.newRoot || "") });
        } else if (body.action === "rescan") {
            requireOwnerProjectRoot(ctx.state.store, projectId);
            const result = await ctx.state.store.catalogProjectSessions(projectId, { fullRescan: true });
            return ownerJson({
                projects: listOwnerProjects(ctx.state.store),
                diagnostics: sanitizeOwnerDiagnosticValue(result.diagnostics || []),
            });
        } else throw new Error("Unknown Project action.");
        return ownerJson({ projects: listOwnerProjects(ctx.state.store) });
    } catch (error) {
        return ownerErrorJson(error);
    }
}

/** @param {any} ctx */
/** @param {any} ctx */
export async function ownerProjectBoardApi(ctx) {
    try {
        const root = requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const board = await loadBoard(root);
        const requestedView = ctx.params.view || "active";
        const view = requestedView === "closed"
            ? "closed"
            : requestedView === "onHold" || requestedView === "on-hold"
            ? "onHold"
            : "active";
        const screen = board.screens?.[view] || { columns: [] };
        return ownerJson({
            projectId: ctx.params.projectId,
            view,
            board: sanitizeOwnerPlanValue(ownerReadOnlyPlanValue(screen)),
            readOnly: true,
        });
    } catch (error) {
        return ownerErrorJson(error, 404);
    }
}

/** @param {any} ctx */
export async function ownerProjectPlanDetailApi(ctx) {
    try {
        const root = requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        const plan = ownerReadOnlyPlanValue(await loadWorkspaceDetail(root, ctx.params.planId));
        return ownerJson({ projectId: ctx.params.projectId, plan: sanitizeOwnerPlanValue(plan), readOnly: true });
    } catch (error) {
        return ownerErrorJson(error, 404);
    }
}

/** @param {any} ctx */
export async function ownerProjectFileContentApi(ctx) {
    try {
        const root = requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId);
        return await reviewFileContentApi(ctx.req, { cwd: root });
    } catch (error) {
        return ownerErrorJson(error, 404);
    }
}

/**
 * Resolve a saved association even when navigation supplied only a Plan ID.
 * @param {import('../../../shared/owner-coordination/index.js').OwnerCoordinationStore} store
 * @param {string} projectId
 * @param {string} planId
 */
export async function associatedPlanSession(store, projectId, planId) {
    let selected = "";
    let selectedAt = "";
    let selectedCurrent = false;
    for (let page = 0;; page++) {
        const batch = await store.listProjectSessions(projectId, {
            catalog: false,
            archiveState: "all",
            page,
            pageSize: 100,
        });
        for (const session of batch.sessions) {
            const associations = store.listSessionPlanAssociations(session.runwieldSessionId, projectId)
                .filter((entry) => entry.committedGeneration !== null);
            const association = associations.findLast((entry) => entry.planId === planId);
            if (!association) continue;
            const current = associations.at(-1)?.planId === planId;
            if (
                !selected || (current && !selectedCurrent) ||
                (current === selectedCurrent && association.recordedAt > selectedAt)
            ) {
                selected = session.runwieldSessionId;
                selectedAt = association.recordedAt;
                selectedCurrent = current;
            }
        }
        if (!batch.hasNext) return selected;
    }
}

/** @param {any} ctx */
export async function ownerProjectPlanProgressApi(ctx) {
    try {
        const url = new URL(ctx.req.url);
        const runwieldSessionId = url.searchParams.get("session") ||
            await associatedPlanSession(ctx.state.store, ctx.params.projectId, ctx.params.planId);
        const progress = await loadOwnerPlanProgress(ctx.state.store, {
            projectId: ctx.params.projectId,
            planId: ctx.params.planId,
            runwieldSessionId: runwieldSessionId || null,
        });
        if (runwieldSessionId) await ctx.state.sessionContinuation.liveSession(ctx.params.projectId, runwieldSessionId);
        let live = null;
        let effectiveSessionId = runwieldSessionId;
        for (const [operationId, operation] of ctx.state.sessionContinuation.operations?.entries?.() || []) {
            if (operation.projectId !== ctx.params.projectId) continue;
            if (runwieldSessionId && operation.runwieldSessionId !== runwieldSessionId) continue;
            if (operation.status !== "running" || !operation.liveInteraction?.interactionId) continue;
            const request = operation.liveInteraction.request || {};
            const planReview = request.planReview && typeof request.planReview === "object" ? request.planReview : null;
            const codeReview = request.codeReview && typeof request.codeReview === "object" ? request.codeReview : null;
            const associations = /** @type {Array<{ planId?: string, committedGeneration?: number | null }>} */ (
                ctx.state.store.listSessionPlanAssociations?.(
                    operation.runwieldSessionId,
                    ctx.params.projectId,
                ) || []
            );
            const info = operation.runtimeSessionId
                ? ctx.state.sessionContinuation.runtime.getSessionSnapshot(operation.runtimeSessionId)
                : operation.sessionInfo;
            // A Session may have worked on several Plans. Only the current operation
            // or live workflow can own its prompt; historical associations are not ownership.
            const currentPlanId = planReview?.planId || codeReview?.planId || operation.planId ||
                info?.activeExecutionWorkflow?.triageMeta?.planId || info?.workflowContext?.planId ||
                info?.planAssociations?.at(-1)?.planId || associations.at(-1)?.planId;
            if (currentPlanId !== ctx.params.planId) continue;
            effectiveSessionId = operation.runwieldSessionId || effectiveSessionId;
            live = { operationId, interactionId: operation.liveInteraction.interactionId, request };
            break;
        }
        const sessionHref = effectiveSessionId
            ? `/projects/${encodeURIComponent(ctx.params.projectId)}/sessions/${encodeURIComponent(effectiveSessionId)}`
            : "";
        const inspected = effectiveSessionId ? ctx.state.store.inspectSessionActivation?.(effectiveSessionId) : null;
        const continuable = Boolean(
            (effectiveSessionId
                ? inspected?.activation?.state === "idle"
                : ["approved", "ready_for_work", "on_hold"].includes(progress.plan.status)) &&
                progress.overall?.state !== "completed" && !progress.degraded &&
                [
                    "approved",
                    "ready_for_work",
                    "on_hold",
                    "in_progress",
                    "failed",
                    "ready_for_decomposition",
                    "implemented",
                    "validated_ci",
                    "reviewed",
                    "validated",
                ].includes(progress.plan.status),
        );
        const canRecover = continuable && progress.overall?.state === "needs_attention";
        const evidence = progress.plan.status === "on_hold"
            ? await loadPlanActionEvidence(
                requireOwnerProjectRoot(ctx.state.store, ctx.params.projectId),
                ctx.params.planId,
            )
            : null;
        return ownerJson({
            ...progress,
            sessionHref,
            interactionHref:
                live && sessionHref && live.request?.type !== "plan_review" && live.request?.type !== "code_review"
                    ? `${sessionHref}#interaction-${encodeURIComponent(live.interactionId)}`
                    : "",
            reviewHref: live?.request?.reviewUrl || "",
            reviewKind: live?.request?.type === "plan_review"
                ? "plan"
                : live?.request?.type === "code_review"
                ? "code"
                : "",
            continueUrl: "",
            planWorkflowUrl: effectiveSessionId
                ? `/api/owner/projects/${encodeURIComponent(ctx.params.projectId)}/sessions/${
                    encodeURIComponent(effectiveSessionId)
                }/plan-workflow`
                : `/api/owner/projects/${encodeURIComponent(ctx.params.projectId)}/plans/${
                    encodeURIComponent(ctx.params.planId)
                }/workflow`,
            expectedRevision: evidence?.kind === "success" ? evidence.evidence.revision : null,
            recoveryUrl: "",
            canRecover,
            canResume: continuable,
            canRun: false,
            expectedGeneration: inspected?.generation?.generation ?? null,
            expectedCurrentSegmentId: inspected?.generation?.currentSegmentId ?? null,
        });
    } catch (error) {
        return ownerErrorJson(error, 404);
    }
}

/** @param {any} ctx */
export async function ownerProjectPlanActionApi(ctx) {
    try {
        const body = await readJson(ctx.req);
        if (typeof body.requestId !== "string" || !body.requestId) {
            throw new Error("Plan action requestId is required.");
        }
        if (typeof body.runwieldSessionId !== "string" || !body.runwieldSessionId) {
            throw new Error("Plan action stable Session ID is required.");
        }
        const action = { ...(body.action || {}), planId: ctx.params.planId };
        const hash = await requestHash({
            projectId: ctx.params.projectId,
            runwieldSessionId: body.runwieldSessionId,
            expectedGeneration: body.expectedGeneration,
            action,
        });
        const result = await runOwnerPlanAction(ctx.state.store, {
            projectId: ctx.params.projectId,
            runwieldSessionId: body.runwieldSessionId,
            deviceId: ctx.state.ownerDevice?.deviceId || null,
            requestId: body.requestId,
            requestHash: hash,
            expectedGeneration: Number(body.expectedGeneration),
            action,
        });
        return ownerJson(sanitizeOwnerPlanValue(result.body), result.status);
    } catch (error) {
        return ownerErrorJson(error);
    }
}

/** @param {any} ctx */
export function devicesApi(ctx) {
    return ownerJson({
        devices: ctx.state.store.listDevices(),
        currentDeviceId: ctx.state.ownerDevice?.deviceId || null,
    });
}

/** @param {any} ctx */
export async function revokeDeviceApi(ctx) {
    try {
        const body = await readJson(ctx.req);
        const device = ctx.state.store.revokeDevice(ctx.params.deviceId, { reason: body.reason || "revoked" });
        ctx.state.ownerConnections?.closeDevice?.(ctx.params.deviceId);
        const headers = new Headers();
        if (ctx.state.ownerDevice?.deviceId === ctx.params.deviceId) {
            for (const header of clearDeviceCookieHeaders({ publicOrigin: ctx.state.publicOrigin })) {
                headers.append("set-cookie", header);
            }
        }
        return ownerJson({ device }, 200, headers);
    } catch (error) {
        return ownerErrorJson(error);
    }
}
