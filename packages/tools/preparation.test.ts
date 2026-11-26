import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { test } from "node:test";
import { toolRegistry, type InterviewQuestion, type MultiFileEditCandidate } from "@runwield/tools";

test("background task preparation accepts one action's fields and preserves the submitted shell text", () => {
    const backgroundTask = toolRegistry.get("background_task");
    deepStrictEqual(backgroundTask.prepare({ action: "start", command: " echo ok ", timeout: 0.25 }), {
        action: "start",
        command: " echo ok ",
        timeoutMs: 250,
    });
    deepStrictEqual(backgroundTask.prepare({ action: "status", task_id: "background-1" }), {
        action: "status",
        taskId: "background-1",
    });
    throws(() => backgroundTask.prepare({ action: "start", command: " " }), {
        message: "Start requires command and no task_id.",
    });
    throws(() => backgroundTask.prepare({ action: "start", command: "echo ok", timeout: 2_147_484 }), {
        message: "Timeout must be a positive finite number of seconds.",
    });
    throws(() => backgroundTask.prepare({ action: "cancel", task_id: "background-1", timeout: 1 }), {
        message: "cancel requires task_id and no command or timeout.",
    });
});

test("Init preparation keeps omitted settings distinct from an explicit empty setup command", () => {
    const init = toolRegistry.get("init_save_verification_command");
    deepStrictEqual(init.prepare({ setupCommand: "  " }), { ok: true, setupCommand: "" });
    deepStrictEqual(init.prepare({ command: " make test  ", setupCommand: " make setup " }), {
        ok: true,
        verificationCommand: "make test",
        setupCommand: "make setup",
    });
    equal(init.placeholder, 'echo "verification not implemented yet"');
    deepStrictEqual(init.prepare({ verificationNotImplemented: true }), {
        ok: true,
        verificationCommand: init.placeholder,
    });
    equal(init.prepare({ verificationNotImplemented: true, command: "make test" }).ok, false);
    equal(init.prepare({ verificationNotImplemented: false, setupCommand: "" }).ok, false);
});

test("edit preparation preserves malformed legacy input for normal schema validation", () => {
    const edit = toolRegistry.get("edit_docs");
    const incomplete = { file_path: "docs/notes.md", edits: [{ oldText: "before" }] };
    equal(edit.prepareArguments(incomplete), incomplete);
    deepStrictEqual(
        edit.prepareArguments({ file_path: "docs/notes.md", edits: [{ oldText: "before", newText: "after" }] }),
        { path: "docs/notes.md", oldText: "before", newText: "after" },
    );
    equal(edit.validatePath("docs\\notes.MD"), null);
    equal(
        edit.validatePath("docs/notes.mdx"),
        "edit_docs: only Markdown .md files can be modified. Received: docs/notes.mdx",
    );
    equal(toolRegistry.get("write_docs").validatePath("  "), "write_docs: path is required and must end with .md.");

    const multi = toolRegistry.get("multi_file_edit");
    equal(multi.prepareArguments(incomplete.edits), incomplete.edits);
    deepStrictEqual(multi.prepareArguments(incomplete), {
        edits: [{ path: "docs/notes.md", oldText: "before", newText: undefined }],
    });
    const edits = [
        { path: "a", oldText: "first", newText: "one" },
        { path: "b", oldText: "second", newText: "two" },
        { path: "a", oldText: "third", newText: "three" },
    ];
    deepStrictEqual(
        [...multi.groupByPath(edits)],
        [
            ["a", [edits[0], edits[2]]],
            ["b", [edits[1]]],
        ],
    );
});

test("planning input preparation leaves authoritative Plan validation to the caller", () => {
    const plan = toolRegistry.get("plan_written");
    equal(plan.normalizeName(" DOCS/PLANS/ change.MD "), "change");
    deepStrictEqual(plan.executionPolicyOverrides({ executionAgent: "frontend-engineer" }), {
        executionAgent: "frontend-engineer",
    });
    deepStrictEqual(
        toolRegistry.get("record_plan_deviation").prepare({
            supersededRequirement: " original ",
            replacementRequirement: " replacement ",
            reason: " ",
        }),
        { supersededRequirement: "original", replacementRequirement: "replacement" },
    );
    throws(() => toolRegistry.get("slicer_finalize_decomposition").assertConfirmation(" \n "), {
        message: "Explicit user confirmation is required to finalize decomposition.",
    });
});

test("artifact preparation validates the resolved kind path and infers a title", () => {
    const artifact = toolRegistry.get("artifact_written");
    equal(artifact.resolveTitle("docs/prd/fallback-name.md", "Draft\r\n#  Standard Title   \r\n"), "Standard Title");
    equal(artifact.resolveTitle("docs/prd/fallback-name.md", "Draft", "  "), "fallback name");
    equal(artifact.resolveTitle("docs/prd/fallback-name.md", "# Heading", "  Custom title "), "Custom title");
    throws(() => artifact.assertKindPath("adr", "docs/prd/fallback-name.md"), {
        message: "adr artifacts must be stored under docs/adr/",
    });
});

test("Pair checkpoint preparation handles implicit reports and requires a revise instruction", () => {
    const pair = toolRegistry.get("pair_checkpoint");
    equal(pair.resolveAction({ summary: "increment" }), "report");
    equal(pair.resolveAction({ checkpointId: "pair-1" }), "resolve");
    equal(pair.prepareReport({ summary: " " }), null);
    deepStrictEqual(pair.prepareReport({ summary: " increment ", evidence: ["visible"], final: true }), {
        summary: "increment",
        evidence: ["visible"],
        final: true,
    });
    deepStrictEqual(pair.prepareResolution({ checkpointId: " pair-1 ", decision: "revise", revisionDirection: " " }), {
        ok: false,
        reason: "revision_direction_required",
        message: "pair_checkpoint resolve rejected: revisionDirection is required for revise.",
        checkpointId: "pair-1",
    });
});

test("interview preparation validates choices and normalizes free-text answers without a session", () => {
    const interview = toolRegistry.get("user_interview");
    const question = { id: "agree", type: "yes_no", prompt: "Continue?", default: false } satisfies InterviewQuestion;
    const options = interview.choiceOptions(question);
    deepStrictEqual(options, [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No (recommended)" },
        { value: "other", label: "Other" },
    ]);
    deepStrictEqual(interview.prepareChoiceAnswer(question, "no"), { value: false, valueLabel: "no" });
    deepStrictEqual(interview.prepareOtherAnswer(question, " Other wording "), {
        value: "other",
        otherText: "Other wording",
        valueLabel: "Other",
    });
    deepStrictEqual(interview.prepareTextAnswer({ type: "text", prompt: "Verbatim?", allowEmpty: true }, " "), {
        value: " ",
    });
});

test("pure completion and delegation preparation preserves acceptance errors", () => {
    const workRecord = toolRegistry.get("work_record_completed");
    equal(workRecord.validateSections({ title: "Heading", summary: "  " }), "Provide a non-empty title and summary.");
    equal(toolRegistry.get("manual_qa_completed").prepareChecklist(" \n "), null);
    equal(toolRegistry.get("manual_qa_completed").prepareChecklist(" \n - [ ] Check this "), "- [ ] Check this");

    const delegate = toolRegistry.get("delegate_agent");
    deepStrictEqual(delegate.prepare({ mode: "read", brief: "  Read the README. " }), {
        ok: true,
        mode: "read",
        role: "general",
        brief: "Read the README.",
    });
    deepStrictEqual(delegate.prepare({ mode: "write", brief: "Implement it.", background: true }), {
        ok: false,
        mode: "write",
        role: "general",
        error: "background_write_denied",
        message: "Background delegation requires requested read mode.",
    });
    const seeImage = toolRegistry.get("see_image");
    equal(seeImage.resolveQuestion("  What do you see? "), "What do you see?");
    equal(
        seeImage.resolveQuestion(" "),
        "Describe this image in detail for a text-only coding agent. Include all visible UI/content, readable text and error messages, relevant layout, controls, highlighted regions, and visual state. If text or details are unclear, say so explicitly.",
    );
});

test("multi-file preparation retains malformed edit elements and fields for schema validation", () => {
    const multi = toolRegistry.get("multi_file_edit");
    const input = {
        file_path: "docs/example.md",
        edits: [null, false, 42, ["old", "new"], { file_path: "docs/other.md", oldText: 123, newText: ["new"] }],
    };
    const expected: MultiFileEditCandidate = {
        edits: [null, false, 42, ["old", "new"], { path: "docs/other.md", oldText: 123, newText: ["new"] }],
    };
    deepStrictEqual(multi.prepareArguments(input), expected);
});
