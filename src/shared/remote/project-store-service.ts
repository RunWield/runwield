import type { ManagedProjectStoreLaunch } from "./project-store-launch.ts";
import {
    PreparedProjectStore,
    StalePlanWriteError,
    type HomeProjectOwner,
    type PlanExecutionHost,
} from "../../plan-store/index.ts";
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
            if (input.command.kind === "restore-history" && error instanceof StalePlanWriteError)
                return new Response(null, { status: 412 });
            return new Response(null, { status: 409 });
        }
    }
}
