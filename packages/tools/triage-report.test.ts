import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { test } from "node:test";
import { toolRegistry } from "@runwield/tools";

const triage = toolRegistry.get("triage_report");

test("triageReport returns the same JSON on repeat calls without a Session", () => {
    const input = {
        routingIntent: "INQUIRY",
        complexity: "LOW",
        summary: "Explain how a worker resumes.",
    } as const;
    deepStrictEqual(triage.report(input), input);
    strictEqual(JSON.stringify(triage.report(input)), JSON.stringify(triage.report(input)));
});

test("a standalone consumer can triage without loading the app or writing project or user state", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "tools-consumer-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const modules = join(root, "node_modules");
    const project = join(root, "project");
    const home = join(root, "home");
    await Promise.all([mkdir(join(modules, "@runwield"), { recursive: true }), mkdir(project), mkdir(home)]);
    await cp(dirname(fileURLToPath(import.meta.url)), join(modules, "@runwield", "tools"), {
        recursive: true,
        filter: (file) => !file.endsWith("node_modules"),
    });
    const typebox = dirname(fileURLToPath(import.meta.resolve("typebox/package.json")));
    await symlink(typebox, join(modules, "typebox"), "junction");
    const request = { routingIntent: "INQUIRY", complexity: "LOW", summary: "Where are Plans stored?" };
    const program = `import { toolRegistry } from "@runwield/tools";
        console.log(JSON.stringify(toolRegistry.get("triage_report").report(${JSON.stringify(request)})));`;
    const output = execFileSync(process.execPath, ["--no-install", "-e", program], {
        cwd: project,
        env: {
            HOME: home,
            USERPROFILE: home,
            TMPDIR: root,
            PATH: process.env.PATH,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
        encoding: "utf8",
    });
    deepStrictEqual(JSON.parse(output), request);
    deepStrictEqual(await readdir(project), []);
    deepStrictEqual(await readdir(home), []);
});

test("triageReport preserves FEATURE as a Work Kind for a planned change", () => {
    const input = {
        routingIntent: "PLANNED_CHANGE",
        workKind: "FEATURE",
        complexity: "MEDIUM",
        summary: "add a filter",
        sessionName: " add\ta filter ",
    } as const;
    deepStrictEqual(triage.report(input), {
        ...input,
        classification: "PLANNED_CHANGE",
        sessionName: "add a filter",
    });
});

test("triageReport rejects FEATURE as either intent field even with a valid alternate field", () => {
    const input = { complexity: "LOW", summary: "s" };
    for (const fields of [
        { routingIntent: "FEATURE" },
        { classification: "FEATURE" },
        { routingIntent: "FEATURE", classification: "PLANNED_CHANGE" },
        { routingIntent: "PLANNED_CHANGE", classification: "FEATURE" },
    ]) {
        strictEqual(triage.normalizeOutcome({ ...input, ...fields }), null);
        throws(() => Reflect.apply(triage.report, undefined, [{ ...input, ...fields }]), TypeError);
    }
});

test("the triage report schema exposes canonical intents and the FEATURE Work Kind", () => {
    const { exposure, parameters } = triage.definition;
    strictEqual(exposure, "model-only");
    deepStrictEqual(parameters.properties.routingIntent.enum, [
        "INQUIRY",
        "IDEATION",
        "OPERATION",
        "QUICK_FIX",
        "PLANNED_CHANGE",
        "PROJECT",
    ]);
    deepStrictEqual(parameters.properties.classification.enum, parameters.properties.routingIntent.enum);
    deepStrictEqual(parameters.properties.workKind.enum, [
        "BUG_FIX",
        "FEATURE",
        "REFACTOR",
        "MAINTENANCE",
        "DOCUMENTATION",
    ]);
    deepStrictEqual(parameters.required, ["complexity", "summary"]);
});

test("triageReport accepts a canonical intent in the legacy classification field", () => {
    deepStrictEqual(triage.report({ classification: "PROJECT", complexity: "HIGH", summary: "s" }), {
        routingIntent: "PROJECT",
        classification: "PROJECT",
        complexity: "HIGH",
        summary: "s",
    });
});

test("triageReport omits plan classification and Work Kind outside planned work", () => {
    deepStrictEqual(
        triage.report({
            routingIntent: "OPERATION",
            workKind: "DOCUMENTATION",
            complexity: "LOW",
            summary: "s",
        }),
        { routingIntent: "OPERATION", complexity: "LOW", summary: "s" },
    );
});

test("normalizeTriageOutcome rejects a missing intent, an invalid complexity, or an empty summary", () => {
    strictEqual(triage.normalizeOutcome({ complexity: "LOW", summary: "s" }), null);
    strictEqual(triage.normalizeOutcome({ routingIntent: "INQUIRY", complexity: "EXTREME", summary: "s" }), null);
    strictEqual(triage.normalizeOutcome({ routingIntent: "INQUIRY", complexity: "LOW", summary: "" }), null);
    strictEqual(triage.normalizeOutcome(null), null);
});
