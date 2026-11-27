import { isProjectId, type ProjectId } from "@runwield/projects";

/** Authority returned by the personal Project's Plan store. */
export interface ProjectStoreBinding {
    projectId: ProjectId;
    repositoryId: string;
    ownerId: string;
}

/** The authenticated Plan store routes and the serialized body of a validated operation. */
export type ManagedPlanStoreRequest =
    | { route: "/project-store/inspect" | "/project-store/admit"; body?: never }
    | { route: "/project-store"; body: string };

/** Send a Plan store request with the host's authentication and connection lifetime. */
export type RequestManagedPlanStore = (request: ManagedPlanStoreRequest, signal?: AbortSignal) => Promise<Response>;

/** Check that a wire binding identifies exactly one Project, execution repository, and personal owner. */
export function validateProjectStoreBinding(binding: ProjectStoreBinding): void {
    if (
        !binding ||
        typeof binding !== "object" ||
        Array.isArray(binding) ||
        Object.keys(binding).sort().join(",") !== "ownerId,projectId,repositoryId"
    )
        throw new Error("Unsupported request fields.");
    if (
        !isProjectId(binding.projectId) ||
        typeof binding.repositoryId !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(binding.repositoryId) ||
        !/^[a-f0-9]{64}$/.test(binding.ownerId)
    )
        throw new Error("Invalid Project owner binding.");
}

/** Compare personal owner, Project, and repository identities. */
export function sameProjectStoreBinding(left: ProjectStoreBinding, right: ProjectStoreBinding): boolean {
    return (
        left.projectId === right.projectId && left.repositoryId === right.repositoryId && left.ownerId === right.ownerId
    );
}

/** A rejected owner mutation that can be submitted again with a fresh observation. */
export class ProjectStorePreconditionError extends Error {}

/** Maximum bytes in a Plan store message. */
export const PROJECT_STORE_MAX_BYTES = 1024 * 1024;

/** Read a bounded UTF-8 Plan store message. */
export async function readProjectStoreBody(source: Request | Response): Promise<string> {
    const reader = source.body?.getReader();
    if (!reader) throw new Error("Missing store body.");
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > PROJECT_STORE_MAX_BYTES) {
                await reader.cancel();
                throw new Error("Store body too large.");
            }
            parts.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
