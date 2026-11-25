import { type HomeProjectOwner } from "@runwield/projects";
import type { ManagedProjectStoreLaunch } from "./project-store-launch.ts";
import { PreparedProjectStore, StalePlanWriteError, type PlanExecutionHost } from "../../plan-store/index.ts";
import {
    readProjectStoreBody,
    sameProjectStoreBinding,
    validateProjectStoreRequest,
    PROJECT_STORE_MAX_BYTES,
    type ProjectStoreRequest,
} from "./project-store-protocol.ts";

export class LaptopProjectStoreService {
    private readonly owner: PreparedProjectStore;
    constructor(
        cwd: string | HomeProjectOwner,
        execution?: PlanExecutionHost,
        launch?: ManagedProjectStoreLaunch,
        signal?: AbortSignal,
    ) {
        this.owner = new PreparedProjectStore(cwd, execution, launch, signal);
    }
    get binding() {
        return this.owner.binding;
    }
    async handle(request: Request, admitted: () => boolean, mutationsAdmitted = true): Promise<Response> {
        if (!admitted()) return new Response(null, { status: 403 });
        if (request.method !== "POST") return new Response(null, { status: 405 });
        let input: ProjectStoreRequest;
        try {
            input = JSON.parse(await readProjectStoreBody(request));
            validateProjectStoreRequest(input);
        } catch {
            return new Response(null, { status: 400 });
        }
        if (
            ("operationId" in input.command ||
                input.command.kind === "confirm-retention" ||
                input.command.kind === "settle-prune-copies" ||
                input.command.kind === "capture-review" ||
                input.command.kind === "sequence-snapshot") &&
            !mutationsAdmitted
        )
            return new Response(null, { status: 403 });
        if (!admitted() || !sameProjectStoreBinding(input.binding, this.owner.binding))
            return new Response(null, { status: 403 });
        try {
            const result = JSON.stringify(await this.owner.execute(input.command));
            if (new TextEncoder().encode(result).length > PROJECT_STORE_MAX_BYTES)
                return new Response(null, { status: 413 });
            return new Response(result, { headers: { "Content-Type": "application/json" } });
        } catch (error) {
            if (
                error instanceof StalePlanWriteError &&
                (input.command.kind === "restore-history" ||
                    input.command.kind === "save-epic-artifact" ||
                    input.command.kind === "append-epic-qa" ||
                    input.command.kind === "edit-documents" ||
                    (input.command.kind === "author-plan" && input.command.input.expectedRevision === undefined))
            )
                return new Response(null, { status: 412 });
            return new Response(null, { status: 409 });
        }
    }
}
