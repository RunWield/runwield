import {
    ProjectStorePreconditionError,
    readProjectStoreBody,
    type ProjectStoreBinding,
    type RequestManagedPlanStore,
} from "@runwield/plans/project-store-wire";
import type { ProjectStoreCommand, ProjectStoreReply } from "../../plan-store/index.ts";
import { validateProjectStoreRequest, validateProjectStoreReply } from "./project-store-protocol.ts";

/** Validate and execute one legacy command against a bound Plan store. */
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
        if (response.status === 412)
            throw new ProjectStorePreconditionError(
                command.kind === "author-plan"
                    ? "Plan already exists."
                    : command.kind === "edit-documents" || command.kind === "save-epic-artifact"
                      ? "A Plan document changed before the edit."
                      : command.kind === "append-epic-qa"
                        ? "Epic family changed or has no reserved child attempt."
                        : "Plan revision changed before restore.",
            );
        if (!response.ok)
            throw new Error(`Project store request refused (${response.status}); retain its operation identity.`);
        const reply: ProjectStoreReply = JSON.parse(await readProjectStoreBody(response));
        validateProjectStoreReply(reply, request);
        return reply;
    }
}
