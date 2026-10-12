import {
    DEV_OWNER_DEVICE,
    DEV_OWNER_PROJECT,
    DEV_OWNER_SECOND_PROJECT,
    DEV_OWNER_WORKFLOW_PLAN,
    devOwnerPlanProgress,
    devOwnerSessionOptions,
    devOwnerSessionPage,
    devOwnerSetSessionArchive,
    devOwnerSidebar,
    devOwnerTimeline,
} from "../../../server/dev-owner-fixtures.ts";

export const prerender = false;

function json<T>(body: T, status = 200) {
    return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function pageValue(url: URL, name: string, fallback: number) {
    const value = url.searchParams.get(name);
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function routeSegments(context: { params: { segments?: string } }) {
    return String(context.params.segments || "").split("/").filter(Boolean);
}

function devOperationSnapshot(operationId: string) {
    return {
        operationId,
        status: "completed",
        events: [],
        pendingConfiguration: null,
        liveInteraction: null,
        runwieldSessionId: null,
    };
}

function eventStream(body: string) {
    return new Response(body, {
        headers: {
            "cache-control": "no-store",
            "content-type": "text/event-stream",
        },
    });
}

export const GET = async ({ request, params }: { request: Request; params: { segments?: string } }) => {
    if (!import.meta.env.DEV) return json({ error: "Not found." }, 404);
    const segments = routeSegments({ params });
    const url = new URL(request.url);

    if (segments.join("/") === "usage") {
        try {
            // Native Deno import keeps Core's JSR modules out of Vite's Node evaluator.
            const fixture: typeof import("../../../server/dev-usage-fixture.ts") = await Function(
                "specifier",
                "return import(specifier)",
            )(new URL("../../../server/dev-usage-fixture.ts", import.meta.url).href);
            return json(await fixture.devUsageReport(url.searchParams));
        } catch (error) {
            return json({ error: error instanceof Error ? error.message : "Usage could not be loaded." }, 400);
        }
    }
    if (segments.join("/") === "sidebar") return json(devOwnerSidebar());
    if (segments.join("/") === "search") {
        const query = url.searchParams.get("q") || "";
        const contentType = url.searchParams.get("type") || "";
        const result = {
            id: `${DEV_OWNER_PROJECT.projectId}:plan:${DEV_OWNER_WORKFLOW_PLAN.planId}`,
            projectId: DEV_OWNER_PROJECT.projectId,
            projectName: DEV_OWNER_PROJECT.displayName,
            contentType: "plan",
            sourceId: DEV_OWNER_WORKFLOW_PLAN.planId,
            title: DEV_OWNER_WORKFLOW_PLAN.planName,
            snippet: "A Plan fixture for the unified Workspace search surface.",
            revision: "dev-revision",
            freshness: "current",
            destination: `/projects/${DEV_OWNER_PROJECT.projectId}/plans/${DEV_OWNER_WORKFLOW_PLAN.planId}`,
        };
        const results = query && (!contentType || contentType === result.contentType) ? [result] : [];
        return json({
            query,
            page: 1,
            pageSize: pageValue(url, "pageSize", 20),
            total: results.length,
            results,
            projects: [{ projectId: DEV_OWNER_PROJECT.projectId, name: DEV_OWNER_PROJECT.displayName }],
            contentTypes: ["plan", "work-record", "prd", "adr", "design-system", "domain-language", "session"],
            states: [{ projectId: DEV_OWNER_PROJECT.projectId, state: "ready" }],
        });
    }
    if (segments.join("/") === "projects") return json({ projects: [DEV_OWNER_PROJECT, DEV_OWNER_SECOND_PROJECT] });
    if (segments.join("/") === "devices") {
        return json({ devices: [DEV_OWNER_DEVICE], currentDeviceId: DEV_OWNER_DEVICE.deviceId });
    }
    if (segments.join("/") === "pairing/status") {
        return json({ state: "pending", expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() });
    }
    if (segments[0] === "session-operations" && segments[1]) {
        const snapshot = devOperationSnapshot(segments[1]);
        if (segments[2] === "stream") return eventStream(`data: ${JSON.stringify(snapshot)}\n\n`);
        return json(snapshot);
    }

    if (
        segments[0] === "projects" &&
        [DEV_OWNER_PROJECT.projectId, DEV_OWNER_SECOND_PROJECT.projectId].includes(segments[1])
    ) {
        if (segments[2] === "plans" && segments[3] === DEV_OWNER_WORKFLOW_PLAN.planId && segments[4] === "progress") {
            return json(devOwnerPlanProgress());
        }
        if (segments[2] === "session-options") return json(devOwnerSessionOptions(segments[1]));
        if (segments[2] === "sessions" && segments.length === 3) {
            return json(
                segments[1] === DEV_OWNER_SECOND_PROJECT.projectId
                    ? {
                        sessions: [],
                        diagnostics: [],
                        page: 0,
                        pageSize: pageValue(url, "pageSize", 30),
                        total: 0,
                        hasNext: false,
                        hasPrevious: false,
                    }
                    : devOwnerSessionPage(
                        pageValue(url, "page", 0),
                        pageValue(url, "pageSize", 30),
                        url.searchParams.get("archiveState") === "archived",
                    ),
            );
        }
        if (segments[2] === "sessions" && segments[4] === "timeline") {
            return json(devOwnerTimeline(segments[3] || ""));
        }
        if (segments[2] === "sessions" && segments[4] === "live") {
            const timeline = devOwnerTimeline(segments[3] || "");
            return json({
                state: timeline.state,
                generation: timeline.generation,
                operation: null,
            });
        }
    }

    return json({ error: "Dev owner API route not found." }, 404);
};

export const POST = async ({ request, params }: { request: Request; params: { segments?: string } }) => {
    if (!import.meta.env.DEV) return json({ error: "Not found." }, 404);
    const segments = routeSegments({ params });
    if (
        segments[0] === "projects" && segments[1] === DEV_OWNER_PROJECT.projectId && segments[2] === "sessions" &&
        segments.length === 5 && ["archive", "unarchive"].includes(segments[4])
    ) {
        const body = await request.json().catch(() => ({}));
        const result = devOwnerSetSessionArchive(segments[3], segments[4] === "archive", body.confirmed === true);
        return json(result, result.status);
    }
    if (segments.join("/") === "search/refresh") return json({ refreshed: true });
    if (segments.join("/") === "pairing/request") {
        return json({
            code: "DEV123",
            expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            state: "pending",
        }, 201);
    }
    if (segments.join("/") === "pairing/claim") return json({ paired: true, device: DEV_OWNER_DEVICE }, 201);
    if (segments.join("/") === "projects") return json({ project: DEV_OWNER_PROJECT }, 201);
    if (segments[0] === "projects" && segments[1] === DEV_OWNER_PROJECT.projectId && segments[2] === "action") {
        return json({ projects: [DEV_OWNER_PROJECT], diagnostics: [] });
    }
    if (segments[0] === "devices" && segments[2] === "revoke") return json({ device: DEV_OWNER_DEVICE });
    return json({ status: "accepted", operationId: "dev-operation", runwieldSessionId: null, generation: null }, 202);
};
