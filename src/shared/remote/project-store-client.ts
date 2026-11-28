import { PlanServerUpgradeRequiredError } from "@runwield/plans/plan-server";
import {
    ProjectStorePreconditionError,
    readProjectStoreBody,
    type ProjectStoreBinding,
    type RequestManagedPlanStore,
} from "@runwield/plans/project-store-wire";
import { PlanNotFoundError, StalePlanWriteError } from "@runwield/plans/store";
import type { ProjectStoreCommand, ProjectStoreReply } from "../../plan-store/index.ts";
import {
    PROJECT_STORE_PLAN_REVISION_HEADER,
    validateProjectStoreRequest,
    validateProjectStoreReply,
} from "./project-store-protocol.ts";

/** Validate and execute a command against a bound Plan store. */
export class ProjectStoreClient {
    /** Bind the authenticated request to the supplied Plan store owner. */
    constructor(
        private readonly request: RequestManagedPlanStore,
        readonly binding: ProjectStoreBinding,
    ) {}
    /** Send a command and validate that its reply matches the request and owner. */
    async execute(command: ProjectStoreCommand, signal?: AbortSignal): Promise<ProjectStoreReply> {
        const request = { binding: this.binding, command };
        validateProjectStoreRequest(request);
        const response = await this.request({ route: "/project-store", body: JSON.stringify(request) }, signal);
        if (command.kind === "revise-plan") {
            const revision = response.headers.get(PROJECT_STORE_PLAN_REVISION_HEADER);
            if (response.status === 404 && revision === "missing") throw new PlanNotFoundError(command.planId);
            if (response.status === 412 && revision && /^[a-f0-9]{64}$/.test(revision))
                throw new StalePlanWriteError(command.expectedRevision, revision);
        }
        if (response.status === 426 && command.kind === "collaboration" && command.intent.action === "share")
            throw new PlanServerUpgradeRequiredError();
        if (response.status === 412) {
            switch (command.kind) {
                case "collaboration":
                    if (command.intent.action === "share" && command.planId !== undefined)
                        throw new ProjectStorePreconditionError("Plan sharing was refused before publication.");
                    break;
                case "author-plan":
                case "create-plan":
                    throw new ProjectStorePreconditionError("Plan already exists.");
                case "revise-plan":
                    throw new ProjectStorePreconditionError("Plan revision changed before authoring.");
                case "edit-documents":
                case "save-epic-artifact":
                    throw new ProjectStorePreconditionError("A Plan document changed before the edit.");
                case "append-epic-qa":
                    throw new ProjectStorePreconditionError("Epic family changed or has no reserved child attempt.");
                case "restore-history":
                    throw new ProjectStorePreconditionError("Plan revision changed before restore.");
                case "review-decision":
                    throw new ProjectStorePreconditionError(
                        "Plan review evidence changed before approval or feedback.",
                    );
            }
        }
        if (!response.ok)
            throw new Error(`Project store request refused (${response.status}); retain its operation identity.`);
        const reply: ProjectStoreReply = JSON.parse(await readProjectStoreBody(response));
        validateProjectStoreReply(reply, request);
        return reply;
    }
}
