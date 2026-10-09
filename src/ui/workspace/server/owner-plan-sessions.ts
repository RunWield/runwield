/** @module ui/workspace/server/owner-plan-sessions */

import type { OwnerCoordinationStore } from "../../../shared/owner-coordination/index.js";
import { findPlanEvidenceById } from "../../../plan-store.js";
import { findPlanAssociatedSessions } from "../../../shared/session/plan-session-lookup.ts";
import { ownerErrorJson, ownerJson } from "../routes/owner-api.js";
import { requireOwnerProjectRoot } from "./owner-projects.ts";

interface OwnerRouteState {
    store: OwnerCoordinationStore;
}

interface OwnerRouteContext {
    req: Request;
    params: Record<string, string>;
    state: OwnerRouteState;
}

export async function ownerProjectPlanSessionsApi(ctx: OwnerRouteContext): Promise<Response> {
    try {
        const projectId = ctx.params.projectId;
        const planId = ctx.params.planId;
        const root = requireOwnerProjectRoot(ctx.state.store, projectId);
        await findPlanEvidenceById(root, planId);
        const sessions = await findPlanAssociatedSessions(ctx.state.store, { cwd: root, planId });
        return ownerJson({
            planId,
            sessions: sessions.map(({ transcriptPath: _transcriptPath, ...session }) => session),
        });
    } catch (error) {
        return ownerErrorJson(error, 404);
    }
}
