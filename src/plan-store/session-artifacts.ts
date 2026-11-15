import { posix } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { PLANS_DIR_NAME } from "../constants.js";
import { readPlanResourceCatalog } from "../plan-store.js";
import { readPlanResource } from "./documents.ts";
import { readLocalHomeStore } from "./access.ts";
import { currentPackageProject } from "./workflows.ts";
import { EPIC_ARTIFACT_FILE_NAMES } from "../plan-format/artifacts.ts";
import { getEpicArtifactPath } from "./artifacts.ts";

/** Session references are logical routes, not physical storage locations. */
export function planSessionArtifactReference(planName: string): string {
    const name = planName.replaceAll("\\", "/");
    if (!name || name.startsWith("/") || name.split("/").some((part) => !part || part === "." || part === ".."))
        throw new Error("Invalid Plan artifact name.");
    return `${PLANS_DIR_NAME}/${name}.md`;
}

/** Resolve registration against the authoritative source, never a stale delivery copy. */
export async function readPlanSessionArtifact(cwd: string, requestedPath: string, kind: "plan" | "epic-artifact") {
    const path = requestedPath.replaceAll("\\", "/");
    if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "."))
        throw new Error("Plan artifact path must be a relative Plan resource.");
    const resource = kind === "plan" ? "context.md" : posix.basename(path);
    if (kind === "epic-artifact" && !EPIC_ARTIFACT_FILE_NAMES.includes(resource))
        throw new Error("Unknown Epic artifact.");
    return await readLocalHomeStore(
        cwd,
        async () => {
            const catalog = await readPlanResourceCatalog(cwd);
            const plan = catalog.resources.find((entry) => {
                const logical = planSessionArtifactReference(entry.name);
                return kind === "plan"
                    ? path === logical || path === entry.relativePath
                    : path === `${PLANS_DIR_NAME}/${entry.name}/${resource}` ||
                          path === `plans/${entry.planId}/${resource}`;
            });
            if (!plan) throw new Error("Plan artifact is not available in the authoritative Plan store.");
            const relativePath =
                kind === "plan"
                    ? planSessionArtifactReference(plan.name)
                    : `${PLANS_DIR_NAME}/${plan.name}/${resource}`;
            if (kind === "plan" || currentPackageProject()) {
                const document = await readPlanResource(cwd, { planId: plan.planId, planName: plan.name }, resource);
                return { relativePath, markdown: document.body };
            }
            const root = await realpath(cwd);
            const file = await realpath(getEpicArtifactPath(root, plan.name, resource));
            const within = relative(root, file);
            if (!within || within === ".." || within.startsWith(`..${sep}`) || resolve(root, within) !== file)
                throw new Error("Epic artifact must remain inside its admitted Project.");
            return { relativePath, markdown: await readFile(file, "utf8") };
        },
        () => {
            throw new Error("Plan artifact is not available in the authoritative Plan store.");
        },
    );
}
