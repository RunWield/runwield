import type { ProjectStoreBinding, ProjectStoreCommand, ProjectStoreReply } from "../../plan-store/index.ts";
import {
    readProjectStoreBody,
    validateProjectStoreRequest,
    validateProjectStoreReply,
} from "./project-store-protocol.ts";
export class ProjectStorePreconditionError extends Error {}

/** Caller retains operation IDs across timeouts/reconnects. No retry or fallback owner is inferred. */
export class ProjectStoreClient {
    constructor(
        private readonly endpoint: string,
        private readonly credential: string,
        readonly binding: ProjectStoreBinding,
    ) {}
    async execute(command: ProjectStoreCommand, signal?: AbortSignal): Promise<ProjectStoreReply> {
        const request = { binding: this.binding, command };
        validateProjectStoreRequest(request);
        const response = await fetch(new URL("/project-store", this.endpoint), {
            method: "POST",
            headers: { Authorization: `Bearer ${this.credential}`, "Content-Type": "application/json" },
            body: JSON.stringify(request),
            signal,
        });
        if (response.status === 412) throw new ProjectStorePreconditionError("Plan revision changed before restore.");
        if (!response.ok)
            throw new Error(`Project store request refused (${response.status}); retain its operation identity.`);
        const reply: ProjectStoreReply = JSON.parse(await readProjectStoreBody(response));
        validateProjectStoreReply(reply, request);
        return reply;
    }
}
