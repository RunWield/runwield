import { createHash } from "node:crypto";
import { agentRegistry } from "../../shared/session/agent-registry.ts";

function digest(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

/** Report definition and paragraph digests to keep Agent instructions out of the qualification logs. */
export async function checkPackagedAgents(projectRoot: string): Promise<void> {
    const primary = await agentRegistry.list(projectRoot, "all");
    const router = primary.find((agent) => agent.name === agentRegistry.ids.primary.ROUTER);
    if (!router) throw new Error("Package smoke could not load the Router definition.");

    const isolated = [];
    for (const id of Object.values(agentRegistry.ids.isolated)) {
        isolated.push(await agentRegistry.isolated.load(id, { projectRoot }));
    }
    for (const id of [agentRegistry.ids.isolated.REVIEWER, agentRegistry.ids.isolated.INTEGRATION_REVIEWER]) {
        isolated.push(await agentRegistry.isolated.load(id, { projectRoot, reviewerMode: "verify" }));
    }
    isolated.push(
        await agentRegistry.isolated.load(agentRegistry.ids.isolated.DELEGATED_READ, {
            projectRoot,
            delegatedRole: "verification-adversary",
        }),
    );
    console.log(`Agent definitions ${digest(JSON.stringify({ primary, isolated }))}`);
    console.log(`Router prompt paragraphs ${router.systemPrompt.split("\n\n").map(digest).join(",")}`);
}
