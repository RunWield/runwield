import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { test } from "node:test";
import * as agents from "@runwield/agents";
import { withProcessGlobalTestLock } from "../../src/testing/process-global-lock.ts";

const { createAgentRegistry } = agents;

async function createLayer(root: string): Promise<string> {
    const layer = join(root, ".wld", "agents");
    await mkdir(layer, { recursive: true });
    return layer;
}

function definition(displayName: string, prompt: string, tools: string[]): string {
    return `---\nname: ${displayName}\ntools: ${JSON.stringify(tools)}\n---\n\n${prompt}\n`;
}

test("the zero-argument registry loads bundled roles and their system template", async () => {
    assert.deepEqual(Object.keys(agents), ["createAgentRegistry"]);
    const factoryArity: Parameters<typeof createAgentRegistry>["length"] extends 0 ? 0 : never = 0;
    assert.equal(createAgentRegistry.length, factoryArity);
    const registry = createAgentRegistry();
    const router = await registry.get(registry.ids.primary.ROUTER);
    assert.equal(router.name, "router");
    assert.equal(router.displayName, registry.displayName("router"));
    assert.ok(router.rolePrompt.length > 0);
    assert.ok(router.systemPrompt.includes(router.rolePrompt));
    assert.notEqual(router.systemPrompt, router.rolePrompt);
    assert.ok(router.tools.includes("set_session_name"));

    const planEngineer = registry.ids.primary.PLAN_ENGINEER;
    assert.ok(await registry.isWorkflowOnly(planEngineer));
    assert.ok((await registry.list(undefined, "all")).some((role) => role.name === planEngineer));
    assert.ok((await registry.list()).every((role) => role.name !== planEngineer));
    assert.ok(!(await registry.listNames()).includes(registry.ids.isolated.SLICER));

    const reviewer = await registry.isolated.load(registry.ids.isolated.REVIEWER);
    assert.ok(reviewer.systemPrompt.length > 0);
    assert.equal(reviewer.tools.includes("set_session_name"), false);

    const home = env.WLD_TEST_SANDBOX_HOME;
    assert.ok(home);
    const cache = await registry.getBundledDefinitionsPath();
    assert.equal(cache, join(home, ".wld", "bundled-agent-definitions"));
    assert.equal(
        await readFile(join(cache, "router.md"), "utf8"),
        await readFile(new URL("./definitions/router.md", import.meta.url), "utf8"),
    );

    const reference = join(cache, "document-formats", "PRD-FORMAT.md");
    const expected = await readFile(new URL("./definitions/document-formats/PRD-FORMAT.md", import.meta.url), "utf8");
    await rm(reference);
    assert.equal(await registry.getBundledDefinitionsPath(), cache);
    assert.equal(await readFile(reference, "utf8"), expected);
    await rm(cache, { recursive: true });
    assert.equal(await registry.getBundledDefinitionsPath(), cache);
    assert.equal(await readFile(reference, "utf8"), expected);
});

test("the registry applies project and personal overrides and refreshes its presentation metadata on load", async () => {
    const home = env.WLD_TEST_SANDBOX_HOME;
    assert.ok(home);
    const root = await mkdtemp(join(tmpdir(), "runwield-agent-registry-"));
    const personalFile = join(home, ".wld", "agents", "router.md");
    try {
        await createLayer(home);
        const projectRoot = join(root, "project");
        const project = await createLayer(projectRoot);
        const routerFile = join(project, "router.md");
        await writeFile(personalFile, definition("Personal Router", "PERSONAL_ROUTER", ["bash"]));
        await writeFile(routerFile, definition("Project Router", "PROJECT_ROUTER", ["delegate_agent_read"]));

        const registry = createAgentRegistry();
        assert.equal(registry.displayName("router", projectRoot), "Project Router");
        const router = await registry.get(" ROUTER ", projectRoot);
        assert.ok(router.rolePrompt.includes("PERSONAL_ROUTER\n\nPROJECT_ROUTER"));
        assert.deepEqual(router.delegationModes, ["read"]);
        assert.ok(router.tools.includes("delegate_agent"));
        assert.ok(router.tools.includes("triage_report"));
        assert.equal(router.tools.includes("bash"), false);
        assert.deepEqual(registry.selectTools(router.tools, ["delegate_agent", "bash"], ["custom"]), [
            "delegate_agent",
            "set_session_name",
            "custom",
        ]);

        await writeFile(routerFile, definition("Edited Router", "EDITED_ROUTER", []));
        assert.equal(registry.displayName("router", projectRoot), "Project Router");
        const freshRegistry = createAgentRegistry();
        assert.equal(freshRegistry.displayName("router", projectRoot), "Edited Router");
        assert.equal((await registry.get("router", projectRoot)).displayName, "Edited Router");
        assert.equal(registry.displayName("router", projectRoot), "Edited Router");
        assert.equal(registry.displayName("router"), "Personal Router");
    } finally {
        await rm(personalFile, { force: true });
        await rm(root, { recursive: true, force: true });
    }
});

test("metadata and the bundled definitions cache follow the active home", async () => {
    await withProcessGlobalTestLock(async () => {
        const root = await mkdtemp(join(tmpdir(), "runwield-agent-scope-"));
        const previousHome = env.HOME;
        try {
            const firstHome = join(root, "first");
            const secondHome = join(root, "second");
            const firstRouter = join(await createLayer(firstHome), "router.md");
            const secondRouter = join(await createLayer(secondHome), "router.md");
            await writeFile(firstRouter, "---\nname: First Router\nbusyLines: [First label]\n---\nFirst prompt.");
            await writeFile(secondRouter, "---\nname: Second Router\nbusyLines: [Second label]\n---\nSecond prompt.");

            env.HOME = firstHome;
            const registry = createAgentRegistry();
            assert.equal(
                await registry.getBundledDefinitionsPath(),
                join(firstHome, ".wld", "bundled-agent-definitions"),
            );
            await registry.get("router", root);
            assert.equal(registry.displayName("router", root), "First Router");
            assert.deepEqual(registry.busyLines("router", root), ["First label"]);

            env.HOME = secondHome;
            assert.equal(
                await registry.getBundledDefinitionsPath(),
                join(secondHome, ".wld", "bundled-agent-definitions"),
            );
            assert.equal(registry.displayName("router", root), "Second Router");
            assert.deepEqual(registry.busyLines("router", root), ["Second label"]);
            await writeFile(secondRouter, "---\nname: Second Router\nbusyLines: []\n---\nSecond prompt.");
            await registry.get("router", root);
            assert.equal(registry.busyLines("router", root), undefined);

            env.HOME = firstHome;
            assert.equal(registry.displayName("router", root), "First Router");
            assert.deepEqual(registry.busyLines("router", root), ["First label"]);
        } finally {
            if (previousHome === undefined) delete env.HOME;
            else env.HOME = previousHome;
            await rm(root, { recursive: true, force: true });
        }
    });
});
