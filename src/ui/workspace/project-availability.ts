import type { OwnerProjectView } from "./server/owner-projects.ts";

export function isProjectAvailable(project: Pick<OwnerProjectView, "status" | "healthStatus">) {
    return project.status === "active" && project.healthStatus === "available";
}
