import { test } from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { makeTempDirectory } from "../../testing/temp-file.ts";
import { buildAiReviewPrompt, validateAiReviewResult } from "./ai-review.ts";

const PATCH = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -2,2 +2,3 @@
 context
-old
+new
+extra
@@ -20 +21 @@
-before
+after
diff --git a/b.ts b/b.ts
new file mode 100644
--- /dev/null
+++ b/b.ts
@@ -0,0 +1 @@
+export const b = 1;
`;
const finding = {
    axis: "spec",
    severity: "issue",
    file: "a.ts",
    side: "new",
    lineStart: 3,
    lineEnd: 4,
    title: "Preserve the value",
    body: "Spec: retain the previous value.",
};
function validate(overrides = {}) {
    return validateAiReviewResult(
        JSON.stringify({ schemaVersion: 1, specSource: "PR description", findings: [{ ...finding, ...overrides }] }),
        { rawPatch: PATCH },
    );
}

for (const scenario of [
    { name: "added range", overrides: {}, scope: "line", start: 3, end: 4, side: "new" },
    {
        name: "deleted line",
        overrides: { side: "old", lineStart: 3, lineEnd: 3 },
        scope: "line",
        start: 3,
        end: 3,
        side: "old",
    },
    {
        name: "default one-line hunk",
        overrides: { lineStart: 21, lineEnd: 21 },
        scope: "line",
        start: 21,
        end: 21,
        side: "new",
    },
    {
        name: "outside hunk",
        overrides: { lineStart: 8, lineEnd: 8 },
        scope: "file",
        start: null,
        end: null,
        side: "new",
    },
    {
        name: "range spanning hunks",
        overrides: { lineStart: 3, lineEnd: 21 },
        scope: "file",
        start: null,
        end: null,
        side: "new",
    },
    {
        name: "zero-count deleted side",
        overrides: { file: "b.ts", side: "old", lineStart: 1, lineEnd: 1 },
        scope: "file",
        start: null,
        end: null,
        side: "old",
    },
    {
        name: "unchanged file",
        overrides: { file: "unchanged.ts" },
        scope: "general",
        start: null,
        end: null,
        side: "new",
    },
    {
        name: "whole change",
        overrides: { file: null, lineStart: null, lineEnd: null },
        scope: "general",
        start: null,
        end: null,
        side: "new",
    },
]) {
    test(`places AI finding: ${scenario.name}`, () => {
        const result = validate(scenario.overrides);
        if (!result.ok) throw new Error(result.error);
        const annotation = result.value.annotations[0];
        assertEquals(annotation.scope, scenario.scope);
        assertEquals(annotation.filePath, { ...finding, ...scenario.overrides }.file);
        assertEquals(
            [annotation.lineStart, annotation.lineEnd, annotation.side],
            [scenario.start, scenario.end, scenario.side],
        );
        assertEquals(annotation.source, "ai-review");
        assertEquals(annotation.author, "AI review");
        assertEquals(annotation.severity, "issue");
        assertEquals(annotation.text.startsWith("**Spec · blocking** — Preserve the value"), true);
        assertStringIncludes(annotation.text, finding.body);
        if (scenario.scope !== "line" && annotation.filePath) {
            assertStringIncludes(
                annotation.text,
                `Location: ${annotation.filePath}:${{ ...finding, ...scenario.overrides }.lineStart}`,
            );
        }
        assertEquals(result.value.counts, { standards: 0, spec: 1, tests: 0 });
    });
}

test("accepts fenced findings and counts advisory findings on all axes", () => {
    const result = validateAiReviewResult(
        `Here are findings:\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, specSource: null, findings: ["standards", "spec", "tests"].map((axis) => ({ ...finding, axis, severity: "advisory" })) })}\n\`\`\``,
        { rawPatch: PATCH },
    );
    if (!result.ok) throw new Error(result.error);
    assertEquals(result.value.counts, { standards: 1, spec: 1, tests: 1 });
    assertEquals(result.value.specSource, null);
    assertEquals(
        result.value.annotations.every(
            (annotation) => annotation.text.includes("· advisory**") && annotation.severity === "advisory",
        ),
        true,
    );
    assertEquals(new Set(result.value.annotations.map((annotation) => annotation.id)).size, 3);
});

test("no spec and no findings is a completed empty review", () => {
    const result = validateAiReviewResult('{"schemaVersion":1,"specSource":null,"findings":[]}', { rawPatch: PATCH });
    assertEquals(result, {
        ok: true,
        value: { specSource: null, counts: { standards: 0, spec: 0, tests: 0 }, annotations: [] },
    });
});

for (const raw of [
    "",
    "not JSON",
    JSON.stringify({ schemaVersion: 1, specSource: null, findings: [{ ...finding, lineStart: "3" }] }),
    '{"schemaVersion":2,"specSource":null,"findings":[]}',
    '{"schemaVersion":1,"findings":[]}',
    JSON.stringify({ schemaVersion: 1, specSource: null, findings: [{ ...finding, axis: "invented" }] }),
]) {
    test(`rejects invalid AI result ${raw.slice(0, 70)}`, () => {
        assertEquals(validateAiReviewResult(raw, { rawPatch: PATCH }).ok, false);
    });
}

test("headless prompt expands the project review skill and includes target and safety rules", async () => {
    const cwd = await makeTempDirectory();
    try {
        await mkdir(join(cwd, ".wld/skills/review"), { recursive: true });
        await writeFile(
            join(cwd, ".wld/skills/review/SKILL.md"),
            "---\nname: review\ndescription: Review changes\n---\nProject review rule: retain customer values.\n",
        );
        const options = {
            mode: "pr",
            gitRef: "review-head",
            baseLabel: "main",
            reviewContext: "PR description",
            diffText: PATCH,
            cwd,
        };
        const prompt = await buildAiReviewPrompt(options);
        for (const text of [
            "Project review rule",
            "Never ask",
            "Never post",
            "Never edit",
            "three sequential passes",
            "specSource: null",
            "git show review-head:<path>",
            "Base: main",
            "PR description",
            PATCH,
        ])
            assertStringIncludes(prompt, text);
        const local = await buildAiReviewPrompt({ ...options, mode: "uncommitted" });
        assertStringIncludes(local, "Read head files in the current checkout.");
    } finally {
        await rm(cwd, { recursive: true });
    }
});

test("valid JSON findings can contain fenced code in their body", () => {
    const body = "The spec requires a default:\n```ts\nconst answer = 2;\n```\nKeep this example.";
    const result = validateAiReviewResult(
        JSON.stringify({ schemaVersion: 1, specSource: "PR", findings: [{ ...finding, body }] }),
        { rawPatch: PATCH },
    );
    if (!result.ok) throw new Error(result.error);
    assertStringIncludes(result.value.annotations[0].text, body);
});
