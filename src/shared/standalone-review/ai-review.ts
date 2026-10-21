import { expandSkill } from "../session/skill-catalog.ts";
import { parseDiffFiles } from "../workflow/review-diff-tool.js";

interface AiReviewPromptOptions {
    mode: string;
    gitRef: string;
    baseLabel: string;
    reviewContext: string;
    diffText: string;
    cwd: string;
}

export async function buildAiReviewPrompt(options: AiReviewPromptOptions): Promise<string> {
    const skill = await expandSkill("review", undefined, { cwd: options.cwd });
    return `${skill}

## Headless annotation review
Run Standards, Spec, and Tests as three sequential passes. Do not use sub-agents.
Never ask the user. Never post to a Forge. Never edit files.
Discover the spec automatically: PR description, linked documents or tickets, then matching docs/, specs/, or .scratch/ files.
If none is available, report specSource: null (no spec), and do not invent requirements.
These headless rules replace the skill's interactive questions, publication, and Markdown output instructions.
${options.mode === "uncommitted" || options.mode === "worktree" ? "Read head files in the current checkout." : `Read head files with git show ${options.gitRef}:<path>.`}
Return ONLY JSON:
{"schemaVersion":1,"specSource":string|null,"findings":[{"axis":"standards"|"spec"|"tests","severity":"issue"|"advisory","file":string|null,"side":"new"|"old","lineStart":number|null,"lineEnd":number|null,"title":string,"body":string}]}
Include the cited rule or spec evidence in body. Use null positions for findings without line anchors.

Target: ${options.mode} ${options.gitRef}
Base: ${options.baseLabel}
Review context:
${options.reviewContext}

Diff:
${options.diffText}`;
}

export interface AiReviewAnnotation {
    id: string;
    type: "comment";
    scope: "line" | "file" | "general";
    filePath: string | null;
    lineStart: number | null;
    lineEnd: number | null;
    side: "new" | "old";
    text: string;
    author: string;
    source: "ai-review";
    severity: "issue" | "advisory";
    createdAt: number;
}

export interface AiReviewValue {
    specSource: string | null;
    counts: { standards: number; spec: number; tests: number };
    annotations: AiReviewAnnotation[];
}

type AiReviewValidation = { ok: true; value: AiReviewValue } | { ok: false; error: string };

export function validateAiReviewResult(raw: string, { rawPatch }: { rawPatch: string }): AiReviewValidation {
    try {
        const text = raw.trim();
        let result;
        try {
            result = JSON.parse(text);
        } catch {
            const match = /```(?:json)?\s*([\s\S]*?)```/.exec(text) || /(\{[\s\S]*\})/.exec(text);
            if (!match) throw new Error("AI review output was not JSON.");
            result = JSON.parse(match[1]);
        }
        if (
            !result ||
            result.schemaVersion !== 1 ||
            !Array.isArray(result.findings) ||
            !(result.specSource === null || typeof result.specSource === "string")
        ) {
            throw new Error("Invalid AI review schemaVersion, specSource, or findings.");
        }
        const files = parseDiffFiles(rawPatch);
        const counts = { standards: 0, spec: 0, tests: 0 };
        const annotations: AiReviewAnnotation[] = [];
        for (const finding of result.findings) {
            if (
                !finding ||
                !["standards", "spec", "tests"].includes(finding.axis) ||
                !["issue", "advisory"].includes(finding.severity) ||
                !["new", "old"].includes(finding.side) ||
                !(finding.file === null || typeof finding.file === "string") ||
                !(finding.lineStart === null || typeof finding.lineStart === "number") ||
                !(finding.lineEnd === null || typeof finding.lineEnd === "number") ||
                typeof finding.title !== "string" ||
                !finding.title.trim() ||
                typeof finding.body !== "string" ||
                !finding.body.trim()
            ) {
                throw new Error("Invalid AI review finding.");
            }
            const axis = finding.axis as keyof typeof counts;
            counts[axis]++;
            const file = files.find((entry) => entry.path === finding.file);
            const validRange =
                Number.isSafeInteger(finding.lineStart) &&
                finding.lineStart > 0 &&
                Number.isSafeInteger(finding.lineEnd) &&
                finding.lineEnd >= finding.lineStart;
            const inHunk =
                validRange &&
                file &&
                [...file.text.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].some((hunk) => {
                    const offset = finding.side === "old" ? 1 : 3;
                    const start = Number(hunk[offset]);
                    const count = hunk[offset + 1] === undefined ? 1 : Number(hunk[offset + 1]);
                    return count > 0 && finding.lineStart >= start && finding.lineEnd < start + count;
                });
            const scope = inHunk ? "line" : file ? "file" : "general";
            const location =
                scope !== "line" && finding.file
                    ? `\n\nLocation: ${finding.file}${finding.lineStart != null ? `:${finding.lineStart}${finding.lineEnd !== finding.lineStart ? `–${finding.lineEnd}` : ""} (${finding.side})` : ""}`
                    : "";
            annotations.push({
                id: crypto.randomUUID(),
                type: "comment",
                scope,
                filePath: finding.file,
                lineStart: scope === "line" ? finding.lineStart : null,
                lineEnd: scope === "line" ? finding.lineEnd : null,
                side: finding.side,
                text: `**${axis[0].toUpperCase() + axis.slice(1)} · ${finding.severity === "issue" ? "blocking" : "advisory"}** — ${finding.title}\n\n${finding.body}${location}`,
                author: "AI review",
                source: "ai-review",
                severity: finding.severity,
                createdAt: Date.now(),
            });
        }
        return { ok: true, value: { specSource: result.specSource, counts, annotations } };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
