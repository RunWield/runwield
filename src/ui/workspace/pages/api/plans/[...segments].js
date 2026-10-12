import { getCwd } from "../../../../../constants.js";
import {
    applyCanonicalDevLifecycleAction,
    loadCanonicalWorkspaceDetail,
    saveCanonicalDevPlanBody,
    serializeCanonicalPlanError,
} from "../../../server/astro-canonical-data.js";

export const prerender = false;

/** @param {unknown} data @param {number} [status] */
function json(data, status = 200) {
    return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

/** @param {any} context */
function requestContext(context) {
    const cwd = context.request.headers.get("x-runwield-workspace-cwd") || getCwd();
    const segments = String(context.params.segments || "").split("/").filter(Boolean).map(decodeURIComponent);
    return { cwd, segments };
}

/** @param {unknown} error */
async function errorResponse(error) {
    const body = await serializeCanonicalPlanError(error);
    const message = body.error;
    const status = message.includes("not found") || message.includes("Plan not found")
        ? 404
        : message.includes("Unknown") || message.includes("Expected JSON")
        ? 400
        : 409;
    return json({ ...body, blockedReason: status === 409 ? message : undefined }, status);
}

/** @type {import("astro").APIRoute} */
export const GET = async (context) => {
    if (!import.meta.env.DEV) return json({ error: "Not found" }, 404);
    const { cwd, segments } = requestContext(context);
    if (segments.length !== 1) return json({ error: "Not found" }, 404);
    try {
        return json({ plan: await loadCanonicalWorkspaceDetail(cwd, segments[0]) });
    } catch (error) {
        return await errorResponse(error);
    }
};

/** @type {import("astro").APIRoute} */
export const POST = async (context) => {
    if (!import.meta.env.DEV) return json({ error: "Not found" }, 404);
    const { cwd, segments } = requestContext(context);
    let payload;
    try {
        payload = await context.request.json();
    } catch {
        return json({ error: "Request body must be valid JSON." }, 400);
    }

    try {
        if (segments.length === 2 && segments[1] === "lifecycle-action") {
            return json(await applyCanonicalDevLifecycleAction(cwd, segments[0], payload));
        }
        if (segments.length === 2 && segments[1] === "body") {
            if (!payload || typeof payload.body !== "string" || typeof payload.expectedBodyHash !== "string") {
                return json({ error: "Expected JSON payload { body: string, expectedBodyHash: string }." }, 400);
            }
            const plan = await saveCanonicalDevPlanBody(
                cwd,
                segments[0],
                payload.body,
                payload.expectedBodyHash,
            );
            return json({ plan, bodyHash: plan.bodyHash });
        }
        return json({ error: "Not found" }, 404);
    } catch (error) {
        return await errorResponse(error);
    }
};
