/** Provision GitHub credentials and install the two personal Router recipes. */
import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { deployedFactoryProject } from "./project.ts";
import type { JsonRecord } from "../src/shared/jsonc.ts";
import { githubTriageRecipes } from "./github-recipes.ts";

async function output(command: string[]): Promise<string> {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "inherit" });
    const result = await new Response(child.stdout).text();
    if (await child.exited) throw new Error(`${command[0]} failed`);
    return result.trim();
}
async function apply(manifest: string): Promise<void> {
    // Server-side apply keeps credentials out of the last-applied annotation.
    const child = Bun.spawn(["kubectl", "apply", "--server-side", "--field-manager=runwield-recipes", "-f", "-"], {
        stdin: new Blob([manifest]),
        stdout: "inherit",
        stderr: "inherit",
    });
    if (await child.exited) throw new Error("Recipe provisioning failed");
}
const root = resolve(process.env.FACTORY_PROJECT_ROOT || process.cwd());
const repositoryArg = process.argv[2];
const repo: JsonRecord = JSON.parse(
    await output(["gh", "repo", "view", ...(repositoryArg ? [repositoryArg] : []), "--json", "nameWithOwner"]),
);
if (typeof repo.nameWithOwner !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo.nameWithOwner)) {
    throw new Error("Expected a GitHub owner/repository");
}
const details: JsonRecord = JSON.parse(await output(["gh", "api", `repos/${repo.nameWithOwner}`]));
if (typeof details.id !== "number" || !Number.isSafeInteger(details.id) || details.id <= 0) {
    throw new Error("GitHub repository identity is missing");
}
const namespace = process.env.FACTORY_NAMESPACE || "runwield-personal";
const projectId = await deployedFactoryProject(namespace, root);
const manifest = githubTriageRecipes({
    namespace,
    projectId,
    repository: repo.nameWithOwner,
    repositoryId: String(details.id),
    model: process.env.FACTORY_MODEL || "openai/gpt-6.1-sol",
    image: process.env.FACTORY_IMAGE || "localhost/runwield-factory:dev",
    schedule: process.env.FACTORY_SCHEDULE || "0 * * * *",
    batchName: process.env.FACTORY_BATCH_NAME || "github-test-first-ten",
});
// This artifact contains only configuration and stable IDs, never credentials.
const outputPath = resolve(process.env.FACTORY_RECIPES_OUTPUT || ".ci-cache/factory-github-recipes.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(manifest, null, 4) + "\n", { mode: 0o600 });
const token = await output(["gh", "auth", "token", "--hostname", "github.com"]);
if (!token || /\s/.test(token)) throw new Error("GitHub credential is missing");
await apply(
    JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "factory-github-auth", namespace },
        type: "Opaque",
        data: { token: Buffer.from(token).toString("base64") },
    }),
);
// A newly created projected Secret can lag on an existing pod. Start the controller
// with the credential present before admitting the batch or installing the schedule.
console.log(await output(["kubectl", "-n", namespace, "rollout", "restart", "deployment/factory-controller"]));
await output(["kubectl", "-n", namespace, "rollout", "status", "deployment/factory-controller", "--timeout=90s"]);
await apply(JSON.stringify(manifest));
console.log(`Installed GitHub Router recipes for ${repo.nameWithOwner}; Project ID ${projectId}`);
console.log(`Reviewable manifests: ${outputPath}`);
