import { createHash } from "node:crypto";
import type { AgentRegistry } from "@runwield/agents";

/** Compare entire definitions without writing bundled instructions into package qualification logs. */
export async function agentDefinitionDigest(registry: AgentRegistry, projectRoot: string): Promise<string> {
    const primary = await registry.list(projectRoot, "all");
    const isolated = [];
    for (const id of Object.values(registry.ids.isolated)) {
        isolated.push(await registry.isolated.load(id, { projectRoot }));
    }
    for (const id of [registry.ids.isolated.REVIEWER, registry.ids.isolated.INTEGRATION_REVIEWER]) {
        isolated.push(await registry.isolated.load(id, { projectRoot, reviewerMode: "verify" }));
    }
    isolated.push(
        await registry.isolated.load(registry.ids.isolated.DELEGATED_READ, {
            projectRoot,
            delegatedRole: "verification-adversary",
        }),
    );
    return createHash("sha256").update(JSON.stringify({ primary, isolated })).digest("hex");
}
