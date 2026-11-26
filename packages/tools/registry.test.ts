import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { test } from "node:test";
import * as publicApi from "@runwield/tools";
import { toolRegistry, type ToolEntry, type ToolName, type ToolParameters, type ToolRegistry } from "@runwield/tools";

const extensions = [
    "memory",
    "code_search",
    "code_show",
    "code_outline",
    "code_batch",
    "code_refs",
    "code_impact",
    "code_trace",
    "code_investigate",
    "code_structure",
    "code_impls",
    "code_importers",
    "web_search",
    "web_fetch",
    "web_code_search",
    "web_docs_search",
] as const satisfies readonly ToolName[];

test("the public registry owns the complete inventory and the bundled extension prompt order", () => {
    deepStrictEqual(Object.keys(publicApi), ["toolRegistry"]);
    const registry: ToolRegistry = toolRegistry;
    const names = registry.list();
    deepStrictEqual(
        [...names].sort(),
        [
            ...extensions,
            "artifact_written",
            "background_task",
            "create_image",
            "delegate_agent",
            "edit_docs",
            "init_save_verification_command",
            "manual_qa_completed",
            "multi_file_edit",
            "pair_checkpoint",
            "plan_written",
            "qa_checklist_generated",
            "record_plan_deviation",
            "review_complete",
            "review_diff",
            "see_image",
            "set_session_name",
            "slicer_finalize_decomposition",
            "task_completed",
            "triage_report",
            "user_interview",
            "work_record_completed",
            "work_record_read",
            "work_record_search",
            "write_docs",
        ].sort(),
    );
    deepStrictEqual(registry.list("extension"), extensions);
    for (const name of names) {
        equal(registry.has(name), true);
        equal(registry.get(name).name, name);
    }
});

test("membership narrows external names and lookup rejects missing tools and prototype properties", () => {
    function lookup(name: string): ToolEntry | undefined {
        return toolRegistry.has(name) ? toolRegistry.get(name) : undefined;
    }
    equal(lookup("plan_written")?.name, "plan_written");
    for (const name of ["custom", "constructor", "toString", "__proto__"]) {
        equal(lookup(name), undefined);
        throws(() => Reflect.apply(toolRegistry.get, undefined, [name]), RangeError);
    }
});

test("a caller cannot alter membership or another caller's tool schema", () => {
    const names = [...toolRegistry.list()];
    Reflect.set(toolRegistry.list(), 0, "injected");
    deepStrictEqual(toolRegistry.list(), names);
    Reflect.set(toolRegistry.list("extension"), 0, "injected");
    equal(toolRegistry.list("extension")[0], "memory");
    const schema = toolRegistry.get("triage_report").definition.parameters;
    Reflect.set(schema.properties.routingIntent.enum, 0, "injected");
    equal(toolRegistry.get("triage_report").definition.parameters.properties.routingIntent.enum[0], "INQUIRY");
});

test("registered context-dependent tools build definitions from the caller's authority", () => {
    const delegate: ToolEntry<"delegate_agent"> = toolRegistry.get("delegate_agent");
    const request: ToolParameters<"delegate_agent"> = { mode: "read", brief: "Review the API." };
    const definition = delegate.define([request.mode], ["verification-adversary"]);
    deepStrictEqual(definition.parameters.properties.mode.enum, ["read"]);
    deepStrictEqual(definition.parameters.properties.role.enum, ["verification-adversary"]);
    const complete = toolRegistry.get("task_completed");
    equal("browserPreflightOutcome" in complete.define("summary").parameters.properties, false);
    equal("browserPreflightOutcome" in complete.define("frontend-implementation").parameters.properties, true);
});

test("code_batch validates requests and builds bounded results in read order", () => {
    const batch = toolRegistry.get("code_batch");
    const ceiling = 50_000;
    equal(batch.maxOutputChars, ceiling);
    equal(batch.validate({ operations: [] }), "code_batch requires at least one operation.");
    throws(() => batch.report([]), RangeError);
    equal(
        batch.validate({ operations: [{ op: "outline", file: " " }] }),
        "operations[0].file must be a non-empty string for outline.",
    );

    const show = { op: "show", target: "One" } as const;
    const outline = { op: "outline", file: "two.ts" } as const;
    equal(batch.validate({ operations: [show, outline, show] }), null);
    const result = batch.report([
        { operation: show, text: "x".repeat(ceiling + 1), isError: true },
        { operation: outline, text: "function Two", isError: false },
        { operation: show, text: "function One", isError: false },
    ]);

    equal(result.text.length <= ceiling, true);
    const single = batch.report([{ operation: show, text: "x".repeat(ceiling + 1), isError: false }]);
    equal(single.text.length, ceiling);
    equal(single.details.truncated, true);
    equal(result.text.endsWith("## 3. show One\nStatus: success\n\nfunction One"), true);
    equal(result.isError, false);
    deepStrictEqual(result.details, {
        operationCount: 3,
        truncated: true,
        results: [
            { operation: show, status: "error", truncated: true },
            { operation: outline, status: "success", truncated: false },
            { operation: show, status: "success", truncated: false },
        ],
    });
});

test("memory prepares action-specific inputs and checks the requested delete scope", () => {
    const memory = toolRegistry.get("memory");
    deepStrictEqual(memory.prepare({ action: "recall" }), { ok: false, error: "query is required for recall." });
    deepStrictEqual(memory.prepare({ action: "store", content: "Use the isolated runner." }), {
        ok: true,
        request: { action: "store", content: "Use the isolated runner.", scope: "project", core: false },
    });
    deepStrictEqual(memory.prepare({ action: "delete", id: 42 }), {
        ok: false,
        error: "scope is required for delete.",
    });

    const deletion = { action: "delete", id: 42, scope: "global" } as const;
    deepStrictEqual(memory.prepare(deletion), { ok: true, request: deletion });
    const present = { status: "success", present: true } as const;
    const absent = { status: "success", present: false } as const;
    equal(memory.checkDeleteScope(deletion, absent, present), null);
    equal(memory.checkDeleteScope(deletion, present, absent), "id 42 was not found in global memory.");
    equal(
        memory.checkDeleteScope(deletion, present, present),
        "id 42 is ambiguous across project and global memory. Refusing delete.",
    );
});

test("web_search and web_fetch bound returned text using the tool character limit", () => {
    const search = toolRegistry.get("web_search");
    const fetch = toolRegistry.get("web_fetch");
    deepStrictEqual(fetch.limitText("abc", 3), { text: "abc", truncated: false });
    deepStrictEqual(search.limitText("abcdef", 3), {
        text: "abc\n\n[web_search output truncated at 3 characters. Use maxChars or a narrower request for remaining content.]",
        truncated: true,
    });
    equal(fetch.limitText("x".repeat(fetch.maxOutputChars + 1)).truncated, true);
});
