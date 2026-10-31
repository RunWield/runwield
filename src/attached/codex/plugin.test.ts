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

async function readGuidance(path: string, heading?: string): Promise<string> {
    let source = await readFile(join(PLUGIN, "skills/run", path), "utf8");
    if (heading) {
        const section = source.split(`## ${heading}\n`)[1];
        assert(section, `Missing workflow section: ${heading}`);
        source = section.split("\n## ")[0];
    }
    return source.replace(/\s+/g, " ");
}

function includesContracts(text: string, contracts: string[]): void {
    for (const contract of contracts) assert(text.includes(contract), `Missing workflow contract: ${contract}`);
}

test("Codex applies saved per-field spawn preferences and keeps rejected controls resumable", async () => {
    const workers = await readGuidance("SKILL.md", "Fresh Codex workers");
    includesContracts(workers, [
        "`workflow.nextAction.dispatch`",
        "`model` as the native spawn `model`",
        "`thinkingLevel` as `reasoning_effort`",
        'equal to `"inherit"`, omit that spawn argument',
        "Missing dispatch metadata from older compatible Core means both fields inherit",
        'For `status: "invalid"`, show `diagnostics` and stop before spawning',
        "fresh Router or initial Planner worker when either field is explicit",
        "Feedback Planner and all workers below always use fresh contexts",
        '(`fork_turns: "none"` when available)',
        "text in a prompt does not apply a preference",
        "lacks either requested control",
        "report the exact limitation and stop before doing that role's work",
        "do not silently ignore, downgrade, substitute, or activate another workflow",
        "Do not restart a running worker after a file edit",
        "Claim only the native arguments actually accepted",
    ]);
    const planning = await readGuidance("references/planning.md");
    includesContracts(planning, [
        "**Fresh Codex workers**",
        "It fetches its own `get_instructions`",
        "Workers make no lifecycle calls",
        "this conversation submits the result",
        "current dispatch preferences",
    ]);
    for (const path of ["references/implementation.md", "references/validation.md"]) {
        includesContracts(await readGuidance(path), ["**Fresh Codex workers**", "`workflow.nextAction.dispatch`"]);
    }
});

test("Codex resumes by inspecting and disclosing saved work before advancing it", async () => {
    const text = await readGuidance("SKILL.md", "Start or resume");
    const resume = text.split("**Continue existing work**")[1].split("**Ambiguous intent**")[0];
    assert.match(resume, /first call `status` with `inspectOnly: true`/);
    assert.doesNotMatch(resume, /call `activate`/);
    includesContracts(resume, [
        "`{ inspectOnly: true }`",
        "most recent open workflow",
        "Do not activate a new request",
    ]);
    const advance = text.indexOf("call ordinary `status` with that `workflowId`");
    assert(advance > text.indexOf("On resume, show"));
    includesContracts(text.slice(text.indexOf("On resume, show"), advance), [
        "`workflow.plan.planName`",
        "`workflow.nextAction`",
        "`workflow.originHost`",
        "`workflow.requestSummary`",
        "only to inspect status, stop after this summary",
    ]);
    includesContracts(text, [
        "before calling `activate`",
        "Do not require an internal workflow ID for an ordinary resume",
        "Do not fetch role instructions, start checks, or dispatch a worker before showing this summary",
        "same Plan, action, revision, and execution directory",
        "no additional host-switch confirmation",
        "Do not import the other host's conversation",
    ]);
});

test("Codex routes every workflow phase to its packaged action instructions", async () => {
    const source = await readFile(join(PLUGIN, "skills/run/SKILL.md"), "utf8");
    const routes = new Map<string, string>();
    for (const row of source.split("\n").filter((line) => line.startsWith("|"))) {
        const reference = row.match(/\]\((references\/[^)]+)\)/)?.[1];
        if (reference) for (const action of row.matchAll(/`([^`]+)`/g)) routes.set(action[1], reference);
    }
    assert.deepEqual(Object.fromEntries(routes), {
        triage: "references/planning.md",
        plan: "references/planning.md",
        review: "references/planning.md",
        plan_ready: "references/implementation.md",
        plan_saved: "references/implementation.md",
        consent: "references/implementation.md",
        implementation: "references/implementation.md",
        implemented: "references/validation.md",
        validation_recovery: "references/validation.md",
        validation: "references/validation.md",
        code_review: "references/validation.md",
        recorder: "references/validation.md",
        delivered: "references/validation.md",
    });
    includesContracts(source.replace(/\s+/g, " "), [
        "For `return_to_host`, report Core's outcome and return to ordinary Codex work",
        "Unsupported request types do not become FEATURE workflows",
        "unrecognized action or role contract is a recoverable compatibility problem",
    ]);
    const planning = await readGuidance("references/planning.md");
    includesContracts(planning, [
        "`get_instructions`",
        "`runwield.attached.triage/1`",
        "`context.requestText`",
        "`triage_report`",
        "`runwield.attached.planner/1`",
        "`context.projectSetup`",
        "`plan_written`",
        "`payload.actionId`",
        "`payload.planName`",
        "Browser edits are already saved; do not apply them twice",
        "For `plan_saved` after Approve for Later",
        "saved for later, then stop",
    ]);
    const chat = await readGuidance("references/review-chat.md");
    includesContracts(chat, [
        "oldest returned `turnId`",
        "`payload: { turnId, text }`",
        "Chat cannot approve or reject",
        "A revised artifact requires a new browser decision",
        "do not replay the reply against another turn",
    ]);
});

test("Codex workers use fresh contexts and Core's execution directory without owning lifecycle", async () => {
    const workers = await readGuidance("SKILL.md", "Fresh Codex workers");
    includesContracts(workers, [
        "each implementation, review, repair, and Recorder action",
        "new Codex subagent with a fresh context",
        "Do not reuse a previous worker or inherit this conversation's history",
        "disable context inheritance",
        "Core's supplied execution directory for every worker command and edit",
        "Do not enable host-created worktree isolation, create another worktree, or move the invoking checkout",
        "report the missing capability and keep the workflow resumable",
        "Do not substitute a review in this coordinating conversation",
    ]);
    const implementation = await readGuidance("references/implementation.md");
    const disclosure = implementation.indexOf("Before dispatch, send a user-visible message");
    const dispatch = implementation.indexOf("Dispatch a fresh Codex implementation worker");
    assert(disclosure >= 0 && dispatch > disclosure, "Show Core's execution disclosure before dispatching the worker.");
    includesContracts(implementation, [
        "`runwield.attached.implementation/1`",
        "`disclosure`",
        "`executionCwd`",
        "`worktreeBranch`",
        "`.gitignore`",
        "`role`",
        "`planPath`",
        "`planName`",
        "`instructions.text`, pass it verbatim",
        "fetch its complete instructions using `get_instructions`",
        "only the handed-off directory for every edit and command",
        "worker makes no RunWield lifecycle calls and does not commit, merge, push, or publish",
        "A blocker or interrupted turn is not completion",
        "`task_completed`",
        "`payload.message`",
        "restore the same handoff instead of calling `start_execution` again",
        "After a decline, stop",
        "saved Plan and stop",
    ]);
    const repair = await readGuidance("references/validation.md", "Repair");
    includesContracts(repair, [
        "fresh Codex repair worker",
        "request cwd",
        "fetches complete current instructions with `get_instructions`",
        "Core's supplied checkout, including its publication directory",
        "Do not create host worktree isolation",
        "does not commit, merge, push, publish, or make lifecycle calls",
        "`task_completed`",
        "`payload.message`",
        "For a blocked item",
        "do not claim completion",
    ]);
});

test("Codex requires an independent reviewer to inspect complete diffs directly and returns its result unchanged", async () => {
    const review = await readGuidance("references/validation.md", "Independent review");
    includesContracts(review, [
        "Dispatch a fresh Codex reviewer",
        "workflow ID, revision, action ID, request cwd",
        "Do not read, condense, or summarize its role instructions in this conversation",
        "reviewer fetches complete current instructions with `get_instructions` itself",
        "Core's `review_complete` payload schema",
        "`get_artifact`, continuing all truncated reads",
        "direct RunWield MCP access and call `review_diff` itself for every required diff byte",
        "Listing files is not inspection",
        "Each read returns a new revision, which it must use for the next read",
        "no edits, commits, or lifecycle calls",
        "structured `review_complete` outcome and latest revision",
        "If direct MCP access or the payload schema is missing",
        "keep the workflow open",
        "Never relay coordinator reads or fabricate coverage receipts",
        "This conversation submits `review_complete`",
        "reviewer's latest revision",
        "structured outcome unchanged",
        "Preserve finding IDs and field names",
        "dispatch another fresh reviewer with the new action ID and revision",
    ]);
    assert(review.indexOf("call `review_diff` itself") < review.indexOf("This conversation submits `review_complete`"));
});

test("Codex keeps recovery, validation, recording, and publication under Core authority", async () => {
    const recovery = await readGuidance("SKILL.md", "Operation identity and recovery");
    includesContracts(recovery, [
        "new `operationId`",
        "`expectedRevision` equal to its `workflow.revision`",
        "issued `actionId`",
        "Reuse an operation ID only for a retry whose original call returned no result",
        "`get_instructions({ workflowId, actionId })`",
        "do not replace them with copied roles",
        "`nextOffsetBytes` until `truncated` is false",
        "read `status` and continue its saved action",
        "Do not edit lifecycle metadata, fabricate completion, or start another execution to bypass recovery",
        "waitForRevision, timeoutMs: 30000",
        "Closing a page or Codex does not abandon the workflow",
    ]);
    const validation = await readGuidance("references/validation.md");
    includesContracts(validation, [
        "`implemented` or `validation_recovery`, call `start_validation`",
        "Core runs the configured checks",
        "do not start a second copy of the full command",
        "interrupted or timed-out call, read `status`",
        "`requestAvailable`",
        "fetch `get_instructions` to read the decision",
        "`runwield.attached.validation/1`",
    ]);
    const decisions = await readGuidance("references/validation.md", "Decisions and code review");
    includesContracts(decisions, [
        "Show them to the user before submitting an answer",
        "show that source and the exact answer",
        "Otherwise ask and wait",
        "`validation_decision`",
        'outcome: "text"',
        'outcome: "selected"',
        "Core saves the browser decision for the exact diff",
        "Feedback starts a fresh repair; Core re-verifies",
    ]);
    const recorder = await readGuidance("references/validation.md", "Recording and publication");
    includesContracts(recorder, [
        "fresh Codex Recorder",
        "request cwd, and canonical artifact references",
        "`get_instructions`",
        "do not pass this host conversation",
        "returns structured sections without editing files",
        "Submit them unchanged through `work_record_completed`",
        "new action ID to a fresh Recorder",
        "Core alone decides when to record a failure and continue publication",
        "until Core returns `delivered`",
        "Do not commit, push, merge, edit protected metadata, or announce Verified based on a worker's report",
        "Core owns publication and its recovery",
        "Do not save those checks as a new document, memory, or Work Record",
    ]);
});

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
