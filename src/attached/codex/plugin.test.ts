import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import marketplace from "../../../.agents/plugins/marketplace.json" with { type: "json" };
import manifest from "./plugin/.codex-plugin/plugin.json" with { type: "json" };
import mcp from "./plugin/.mcp.json" with { type: "json" };
import adapter from "./plugin/runwield-adapter.json" with { type: "json" };
import { inspectInstalledPluginLaunch } from "./plugin-host-test-fixture.ts";
import { load as loadYaml } from "js-yaml";
import { extractYaml } from "../../shared/front-matter.ts";
import { attachedHost } from "../../shared/attached/hosts.ts";

const CHECKOUT = fileURLToPath(new URL("../../../", import.meta.url));
const PLUGIN = fileURLToPath(new URL("./plugin/", import.meta.url));

test("the Codex repository marketplace resolves the native package without installing it by default", () => {
    assert.equal(marketplace.name, "runwield");
    assert.equal(marketplace.plugins.length, 1);
    const entry = marketplace.plugins[0];
    assert.equal(entry.name, manifest.name);
    assert.equal(entry.source.source, "local");
    assert.equal(resolve(CHECKOUT, entry.source.path), resolve(PLUGIN));
    assert.equal(entry.policy.installation, "AVAILABLE");
    assert.equal(manifest.skills, "./skills/");
    assert.equal(manifest.mcpServers, "./.mcp.json");
    assert.equal(adapter.adapterContract, 1);
});

test("the installed Codex package remains self-contained and leaves project cwd to the host", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "runwield-codex-package-"));
    try {
        const installed = join(temporary, "cache", "runwield", manifest.version);
        await cp(PLUGIN, installed, { recursive: true });
        const files = await readdir(installed, { recursive: true });
        const skills = files.filter((path) => path.endsWith("SKILL.md"));
        assert.deepEqual(skills, ["skills/run/SKILL.md"]);
        const entrypoint = join(installed, skills[0]);
        const source = await readFile(entrypoint, "utf8");
        const metadata = extractYaml(source).attrs;
        assert.equal(metadata.name, "run");
        assert.equal(typeof metadata.description, "string");
        const entrypointName = `$${manifest.name}:${metadata.name}`;
        assert.equal(attachedHost("codex")?.implementEntrypoint, `${entrypointName} implement`);
        assert.equal(attachedHost("codex")?.reviewEntrypoint, `${entrypointName} resume`);
        assert.deepEqual(loadYaml(await readFile(join(dirname(entrypoint), "agents/openai.yaml"), "utf8")), {
            policy: { allow_implicit_invocation: false },
        });
        const visited = new Set<string>();
        const pending = [entrypoint];
        while (pending.length) {
            const path = pending.pop()!;
            if (visited.has(path)) continue;
            visited.add(path);
            const content = await readFile(path, "utf8");
            for (const link of content.matchAll(/\]\(([^)]+\.md)\)/g)) {
                const target = resolve(dirname(path), link[1]);
                assert(target.startsWith(installed + sep), `Skill reference escapes its installed package: ${link[1]}`);
                pending.push(target);
            }
        }
        assert.deepEqual(
            [...visited].map((path) => path.slice(installed.length + 1)).sort(),
            files.filter((path) => path.endsWith(".md")).sort(),
            "Every packaged workflow reference must be reachable from the skill.",
        );
        assert.equal(
            files.some((path) => /(^|\/)hooks?(\/|\.|$)/.test(path)),
            false,
        );
        assert.equal(
            files.some((path) => /(^|\/)commands\//.test(path)),
            false,
        );
        assert.deepEqual(JSON.parse(await readFile(join(installed, "runwield-adapter.json"), "utf8")), adapter);
        assert.deepEqual(JSON.parse(await readFile(join(installed, ".mcp.json"), "utf8")), mcp);
        const server = mcp.mcpServers.runwield;
        assert.equal(server.tool_timeout_sec, 3600);
        assert.equal(server.startup_timeout_sec, 30);
        assert.equal(server.command, "wld");
        assert.deepEqual(server.args, [
            "attached",
            "mcp",
            "codex",
            "--adapter-version",
            manifest.version,
            "--adapter-contract",
            String(adapter.adapterContract),
        ]);
        assert.equal(Object.hasOwn(server, "env"), false);
        assert.equal(Object.hasOwn(server, "cwd"), false);
        assert.equal(Object.hasOwn(server, "timeout"), false);
        assert.equal(JSON.stringify(server).includes("PLUGIN_ROOT"), false);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});

interface InstalledPlugin {
    pluginId: string;
    version: string;
    installedPath: string;
}

interface PluginListing {
    installed: Array<{ pluginId: string; enabled: boolean }>;
    available: Array<{ pluginId: string }>;
}

test("Codex can install and remove the repository package in an isolated configuration", async (context) => {
    const probe = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (probe.error || probe.status !== 0) {
        context.skip("Codex CLI is an optional external acceptance prerequisite.");
        return;
    }
    const temporary = await mkdtemp(join(tmpdir(), "runwield-codex-install-"));
    const home = join(temporary, "home");
    const config = join(temporary, "codex");
    const project = join(temporary, "project");
    try {
        await Promise.all([home, config, project].map((directory) => mkdir(directory)));
        const run = (args: string[]) => {
            const result = spawnSync("codex", args, {
                cwd: project,
                env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: config },
                encoding: "utf8",
                timeout: 30_000,
            });
            assert.equal(result.status, 0, result.stderr || result.error?.message || "Codex command did not succeed.");
            return result.stdout;
        };
        run(["plugin", "marketplace", "add", CHECKOUT, "--json"]);
        const before: PluginListing = JSON.parse(
            run(["plugin", "list", "--marketplace", marketplace.name, "--available", "--json"]),
        );
        assert.equal(before.installed.length, 0);
        assert.deepEqual(
            before.available.map((entry) => entry.pluginId),
            ["runwield@runwield"],
        );
        const installed: InstalledPlugin = JSON.parse(run(["plugin", "add", "runwield@runwield", "--json"]));
        assert.equal(installed.pluginId, "runwield@runwield");
        assert.equal(installed.version, manifest.version);
        assert.equal(installed.installedPath.startsWith(await realpath(config)), true);
        assert.deepEqual(
            JSON.parse(await readFile(join(installed.installedPath, ".codex-plugin", "plugin.json"), "utf8")),
            manifest,
        );
        assert.deepEqual(JSON.parse(await readFile(join(installed.installedPath, ".mcp.json"), "utf8")), mcp);
        const active: PluginListing = JSON.parse(run(["plugin", "list", "--marketplace", marketplace.name, "--json"]));
        assert.deepEqual(
            active.installed.map(({ pluginId, enabled }) => ({ pluginId, enabled })),
            [{ pluginId: "runwield@runwield", enabled: true }],
        );
        assert.deepEqual(await readdir(project), []);
        assert.equal((await readdir(home)).includes(".wld"), false);
        const { launch, skills } = await inspectInstalledPluginLaunch({ home, config, project, temporary });
        assert.deepEqual(launch.args, mcp.mcpServers.runwield.args);
        assert.equal(launch.cwd, await realpath(project));
        assert.equal(launch.clientName, "codex-mcp-client");
        const workflowSkills = skills.filter((entry) => entry.pluginId === installed.pluginId);
        assert.deepEqual(
            workflowSkills.map(({ name, enabled }) => ({ name, enabled })),
            [{ name: "runwield:run", enabled: true }],
        );
        assert.equal(workflowSkills[0].path, join(installed.installedPath, "skills/run/SKILL.md"));
        assert.equal((await readdir(home)).includes(".wld"), false);
        run(["plugin", "remove", "runwield@runwield", "--json"]);
        const removed: PluginListing = JSON.parse(run(["plugin", "list", "--marketplace", marketplace.name, "--json"]));
        assert.equal(removed.installed.length, 0);
        run(["plugin", "marketplace", "remove", marketplace.name, "--json"]);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});
