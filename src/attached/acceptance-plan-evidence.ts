import { createHash } from "node:crypto";
import { field, jsonMap, type JsonMap } from "./claude/acceptance/evidence.ts";

interface EvidenceFile {
    path: string;
    text?: string;
}

/** Join the workflow's recorded checkout to its owner and its exact referenced controller generation. */
export function snapshotPlanEvidence(files: EvidenceFile[], workflow?: JsonMap | null) {
    const name = field(workflow, "plan", "planName");
    const id = field(workflow, "plan", "planId");
    const root = workflow?.projectRoot;
    if (typeof name !== "string" || typeof id !== "string" || typeof root !== "string") return;
    const json = (file?: EvidenceFile): JsonMap | null => {
        if (!file?.text) return null;
        try {
            return jsonMap(JSON.parse(file.text));
        } catch {
            return null;
        }
    };
    const read = (path: string) => json(files.find((file) => file.path === path));
    for (const file of files) {
        const match = /^runwield-home\/\.wld\/projects\/([^/]+)\/project\.wld\.json$/.exec(file.path);
        if (!match) continue;
        const project = json(file);
        if (!project || project.projectId !== match[1] || !Array.isArray(project.repositories)) continue;
        const repository = project.repositories
            .map(jsonMap)
            .find(
                (repo) => Array.isArray(repo?.checkouts) && repo.checkouts.some((item) => field(item, "root") === root),
            );
        const owner = jsonMap(project.personalOwner);
        if (
            typeof repository?.repositoryId !== "string" ||
            typeof owner?.kind !== "string" ||
            typeof owner.identity !== "string"
        )
            continue;
        const projectPath = file.path.slice(0, -"/project.wld.json".length);
        const ownerKey = createHash("sha256")
            .update(owner.kind + "\0" + owner.identity)
            .digest("hex");
        const executionPath = projectPath + "/execution/" + repository.repositoryId + "/" + ownerKey;
        const path = projectPath + "/plans/" + name;
        const metadata = read(path + "/plan.wld.json");
        if (
            metadata?.planId !== id ||
            metadata.name !== name ||
            !files.some((file) => file.path === path + "/context.md")
        )
            continue;
        const revision = field(metadata, "workflow", "controller", "revisionId");
        const evidence =
            typeof revision === "string" && field(metadata, "workflow", "controller", "planId") === id
                ? read(projectPath + "/internal/plan-packages/controller-evidence/" + revision + ".json")
                : null;
        const controller =
            evidence?.planId === id && evidence.planName === id
                ? { state: { ...jsonMap(evidence.state), ...jsonMap(metadata.controller) } }
                : undefined;
        return {
            projectPath,
            executionPath,
            metadata,
            controller,
            delivery: jsonMap(field(metadata, "workflow", "delivery")),
        };
    }
}
