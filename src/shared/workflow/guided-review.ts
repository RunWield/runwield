/**
 * @module shared/workflow/guided-review
 * Deterministic Guided Review policy and fallback explainer helpers.
 */

import { isPlannedChangeClassification } from "../../constants.ts";
import { parseDiffFiles, summarizeDiffForReview } from "./review-diff-tool.ts";

import type { DiffReviewStats } from "./review-diff-tool.ts";
import type { getGuidedReviewMode } from "../settings.js";

export type GuidedReviewMode = ReturnType<typeof getGuidedReviewMode>;

export interface GuidedReviewRecommendation {
    recommended: boolean;
    score: number;
    reasons: string[];
    stats: DiffReviewStats;
}

export interface GuidedReviewPolicy {
    mode: GuidedReviewMode;
    autoStart: boolean;
    manualAvailable: boolean;
    reasons: string[];
    stats: DiffReviewStats;
    score: number;
}

export interface GuidedReviewPlanAttributes extends Record<string, unknown> {
    complexity?: unknown;
    classification?: unknown;
    type?: unknown;
    dependencies?: unknown;
    parentPlan?: unknown;
    parent?: unknown;
    epic?: unknown;
    epicName?: unknown;
}

export interface GuidedReviewRecommendationOptions {
    planAttrs?: unknown;
    planContent?: string;
    diffText: string;
    usedLargeDiffPath?: boolean;
}

export interface FallbackGuidedReviewOptions {
    diffText: string;
    title?: string;
    intent?: string;
}

export interface GuidedReviewPromptOptions {
    diffText: string;
    gitRef: string;
    changedFiles: string[];
    planContent?: string;
    planAttrs?: GuidedReviewPlanAttributes;
    reviewContext?: string;
}

export interface GuidedReviewValidationOptions {
    changedFiles: string[];
}

interface RawGuidedReviewExplainer extends Record<string, unknown> {
    schemaVersion?: unknown;
    title?: unknown;
    sections?: unknown;
    everythingElse?: unknown;
    widgetAssets?: unknown;
}

interface RawGuidedReviewSection {
    title?: unknown;
    role?: unknown;
    blocks?: unknown;
}

interface RawGuidedReviewBlock {
    type?: unknown;
    file?: unknown;
    source?: unknown;
    id?: unknown;
    entry?: unknown;
    html?: unknown;
    assets?: unknown;
}

interface RawGuidedReviewFileReference {
    file?: unknown;
}

interface RawGuidedReviewWidgetAsset {
    name?: unknown;
    path?: unknown;
    content?: unknown;
    contentType?: unknown;
}

interface GuidedReviewValidationSuccess {
    ok: true;
    value: Record<string, unknown>;
}

interface GuidedReviewValidationFailure {
    ok: false;
    errors: string[];
}

export type GuidedReviewValidationResult = GuidedReviewValidationSuccess | GuidedReviewValidationFailure;

interface GuideBlockValidationContext {
    changed: Set<string>;
    seen: Set<string>;
    errors: string[];
    path: string;
}

export const GUIDED_REVIEW_EXPLAINER_SCHEMA_VERSION = "1.0";
export const GUIDED_REVIEW_SECTION_ROLES = [
    "core",
    "consequence",
    "data_flow",
    "ui_behavior",
    "edge_case",
    "support",
    "glue",
];

function hasDeclaredDependencies(attrs: GuidedReviewPlanAttributes) {
    return Array.isArray(attrs.dependencies) ? attrs.dependencies.length > 0 : Boolean(attrs.dependencies);
}

function normalizeComplexity(value: unknown) {
    return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function isChildFeaturePlan(attrs: GuidedReviewPlanAttributes) {
    const classification = normalizeComplexity(attrs.classification);
    return (
        isPlannedChangeClassification(classification) &&
        Boolean(attrs.parentPlan || attrs.parent || attrs.epic || attrs.epicName)
    );
}

function hasVisualAffectedPath(paths: string[]) {
    return paths.some(
        (path) =>
            /(^|\/)(ui|ux|frontend|workspace|react|components?|islands?|pages?|routes?|styles?|css|game|phaser|canvas|animation|diagram)s?(\/|\.|$)/i.test(
                path,
            ) || /\.(astro|jsx|tsx|css|scss|sass|svg|canvas|png|jpg|jpeg|gif|webp)$/i.test(path),
    );
}

/**
 * Build an explainable deterministic recommendation for Guided Review generation.
 *
 */
export function recommendGuidedReview({
    planAttrs,
    planContent = "",
    diffText,
    usedLargeDiffPath = false,
}: GuidedReviewRecommendationOptions): GuidedReviewRecommendation {
    const attrs = planAttrs && typeof planAttrs === "object" ? (planAttrs as GuidedReviewPlanAttributes) : {};
    const entries = parseDiffFiles(diffText);
    const stats = summarizeDiffForReview(entries);
    const changedPaths = entries.map((entry) => entry.path);
    const reasons = [];
    let score = 0;

    const complexity = normalizeComplexity(attrs.complexity);
    if (complexity === "HIGH") {
        score += 3;
        reasons.push("HIGH complexity");
    } else if (complexity === "MEDIUM") {
        score += 2;
        reasons.push("MEDIUM complexity");
    }

    if (usedLargeDiffPath) {
        score += 2;
        reasons.push("large diff path");
    }
    if (stats.changedFiles >= 8) {
        score += 2;
        reasons.push(`${stats.changedFiles} changed files`);
    } else if (stats.changedFiles >= 4) {
        score += 1;
        reasons.push(`${stats.changedFiles} changed files`);
    }
    if (stats.changedLines >= 800) {
        score += 2;
        reasons.push(`${stats.changedLines} changed lines`);
    } else if (stats.changedLines >= 300) {
        score += 1;
        reasons.push(`${stats.changedLines} changed lines`);
    }
    if (isChildFeaturePlan(attrs) && hasDeclaredDependencies(attrs)) {
        score += 2;
        reasons.push("child Planned Change dependencies");
    }
    if (isChildFeaturePlan(attrs)) {
        score += 1;
        reasons.push("child Planned Change Epic context");
    }
    if (stats.meaningfulAreas.length >= 3) {
        score += 2;
        reasons.push(`${stats.meaningfulAreas.length} areas`);
    }
    if (
        /\b(ui|ux|frontend|visual|game|animation|canvas|video|diagram|flow)\b/i.test(planContent) ||
        hasVisualAffectedPath(changedPaths)
    ) {
        score += 1;
        reasons.push("visual or interactive change");
    }
    if (stats.lowSignalOnly) {
        score -= 3;
        reasons.push("low-signal-only diff");
    }

    return { recommended: score >= 4, score, reasons, stats };
}

export function buildGuidedReviewPolicy(
    mode: GuidedReviewMode,
    recommendation: GuidedReviewRecommendation,
    acceptedAsk = false,
): GuidedReviewPolicy {
    const always = mode === "always";
    const autoStart = always || (mode === "auto" && recommendation.recommended) || (mode === "ask" && acceptedAsk);
    return {
        mode,
        autoStart,
        manualAvailable: true,
        reasons: always ? ["guidedReview: always", ...recommendation.reasons] : recommendation.reasons,
        stats: recommendation.stats,
        score: recommendation.score,
    };
}

/**
 * Build a deterministic fallback explainer. Real guide providers can replace this
 * with LLM output, but this keeps the review surface useful and testable.
 *
 */
export function buildFallbackGuidedReviewExplainer({
    diffText,
    title = "Guided Review Explainer",
    intent,
}: FallbackGuidedReviewOptions) {
    const entries = parseDiffFiles(diffText);
    const stats = summarizeDiffForReview(entries);
    const placed = entries.slice(0, Math.min(entries.length, 6));
    const everythingElse = entries.slice(placed.length).map((entry) => ({ file: entry.path }));
    return {
        schemaVersion: GUIDED_REVIEW_EXPLAINER_SCHEMA_VERSION,
        title,
        intent:
            intent ||
            `This explainer organizes ${stats.changedFiles} changed file${
                stats.changedFiles === 1 ? "" : "s"
            } by review flow instead of filesystem order.`,
        sections: [
            {
                title: "Core implementation",
                role: "core",
                blocks: [
                    {
                        type: "prose",
                        markdown:
                            "Start here: these are the primary changed files the reviewer should understand before checking supporting glue.",
                    },
                    {
                        type: "mermaid",
                        title: "Changed-file flow",
                        description: "A compact view of the main files included in this guided review.",
                        source: buildChangedFilesMermaid(placed.map((entry) => entry.path)),
                    },
                    ...placed.map((entry) => ({
                        type: "diff",
                        file: entry.path,
                        summary: `${entry.changeType} file with ${entry.hunkLines.added} added and ${entry.hunkLines.removed} removed lines.`,
                    })),
                ],
            },
            {
                title: "Review checkpoints",
                role: "consequence",
                blocks: [
                    {
                        type: "callout",
                        tone: "review",
                        title: "Review focus",
                        markdown:
                            "Check that the conceptual behavior described by the Plan still matches the implementation, then annotate any questions directly on the embedded diffs below.",
                    },
                    {
                        type: "reviewCheckpoint",
                        markdown: "Confirm tests, user-visible behavior, and edge cases still line up with the Plan.",
                    },
                ],
            },
        ],
        everythingElse,
        widgetAssets: [],
    };
}

/**
 * Build the server-side LLM prompt for a structured Guided Review Explainer.
 *
 */
export function buildGuidedReviewPrompt({
    diffText,
    gitRef,
    changedFiles,
    planContent = "",
    planAttrs = {},
    reviewContext = "",
}: GuidedReviewPromptOptions) {
    return `You are generating a RunWield Guided Review Explainer for ${
        planContent ? "validation-time human code review" : "standalone code review"
    }.\n\nReturn ONLY JSON with this shape:\n{\n  "schemaVersion": "${GUIDED_REVIEW_EXPLAINER_SCHEMA_VERSION}",\n  "title": string,\n  "intent": string,\n  "sections": [{\n    "title": string,\n    "role": "core" | "consequence" | "data_flow" | "ui_behavior" | "edge_case" | "support" | "glue",\n    "blocks": [\n      { "type": "prose", "markdown": string } |\n      { "type": "callout", "tone": string, "title": string, "markdown": string } |\n      { "type": "mermaid", "title": string, "source": string } |\n      { "type": "diff", "file": one_of_changed_files, "summary": string } |\n      { "type": "reviewCheckpoint", "markdown": string } |\n      { "type": "widget", "id": string, "entry": "index.html", "title": string, "reason": string, "html": string }\n    ]\n  }],\n  "everythingElse": [{ "file": one_of_changed_files }]\n}\n\nRules:\n- The intent is a concise summary of the problem and resulting behavior (1-2 sentences), not a description of the guide format.\n- Organize the guide into conceptual chapters: the core behavior first, its consequences next, supporting changes and glue last. Group related files across directories; keep tests beside the implementation they verify.\n- Aim for 2-6 chapters (one for a small change, at most 10). Use descriptive chapter titles rather than filenames or role labels.\n- Begin each chapter with prose explaining what changed, why, and the implications for the reviewer. This prose appears beside the chapter file list and live diffs on wide screens, and above them on narrow screens.\n- Give every diff a concise semantic summary explaining its part in the chapter. Place every changed file exactly once across chapter diffs and everythingElse. Reserve everythingElse for incidental changes.\n- Callouts, diagrams, checkpoints, and optional widgets accompany the chapter overview; they should remain readable in a narrow column.\n- Section role MUST be one of: ${GUIDED_REVIEW_SECTION_ROLES.join(
        ", ",
    )}.\n${
        planContent
            ? "- Ground the explainer in both the Plan and the diff. Explain why the change exists before explaining how the diff implements it."
            : "- Ground the explainer in the review context and diff. There is no Plan. " +
              (gitRef.startsWith("Working tree")
                  ? "Read the current checkout files directly; the diff includes uncommitted edits."
                  : `Read head files with git show ${gitRef}:<path>.`)
    }\n- Prefer prose, callouts, Mermaid, and diff blocks. Use widgets only when Mermaid/prose/diffs are insufficient.\n- Mermaid guidance: choose diagram families that fit the change, such as data flow, sequence, state machine, UI composition, game loop/timeline, or dependency graph diagrams.\n- Every diff.file and everythingElse.file MUST be one of the changed files below.\n- Widget HTML must be self-contained and may not reference external network resources.\n- Do not include Markdown fences or commentary outside JSON.\n\nReview target: ${gitRef}\n${
        planContent ? "Plan metadata:" : "Review metadata:"
    }\n${JSON.stringify(planAttrs, null, 2)}\n\n${planContent ? "Plan content:" : "Review context:"}\n${
        planContent || reviewContext || "Use the diff as context."
    }\n\nChanged files:\n${changedFiles.map((path) => `- ${path}`).join("\n")}\n\nDiff:\n${diffText}`;
}

/**
 * Validate and normalize a generated Guided Review Explainer.
 *
 */
export function validateGuidedReviewExplainer(
    value: unknown,
    { changedFiles }: GuidedReviewValidationOptions,
): GuidedReviewValidationResult {
    const errors: string[] = [];
    const changed = new Set(changedFiles);
    if (!value || typeof value !== "object") return { ok: false, errors: ["Guide output must be a JSON object."] };
    const guide = value as RawGuidedReviewExplainer;
    if (guide.schemaVersion !== GUIDED_REVIEW_EXPLAINER_SCHEMA_VERSION) {
        errors.push(`schemaVersion must be ${GUIDED_REVIEW_EXPLAINER_SCHEMA_VERSION}.`);
    }
    if (typeof guide.title !== "string" || !guide.title.trim()) errors.push("title is required.");
    if (!Array.isArray(guide.sections) || guide.sections.length === 0) {
        errors.push("sections must be a non-empty array.");
    }
    const seen = new Set<string>();
    const sections: unknown[] = Array.isArray(guide.sections) ? guide.sections : [];
    sections.forEach((section, sectionIndex) => {
        if (!section || typeof section !== "object") {
            errors.push(`sections[${sectionIndex}] must be an object.`);
            return;
        }
        const sectionRecord = section as RawGuidedReviewSection;
        if (typeof sectionRecord.title !== "string" || !sectionRecord.title.trim()) {
            errors.push(`sections[${sectionIndex}].title is required.`);
        }
        if (typeof sectionRecord.role !== "string" || !GUIDED_REVIEW_SECTION_ROLES.includes(sectionRecord.role)) {
            errors.push(`sections[${sectionIndex}].role must be one of: ${GUIDED_REVIEW_SECTION_ROLES.join(", ")}.`);
        }
        if (!Array.isArray(sectionRecord.blocks) || sectionRecord.blocks.length === 0) {
            errors.push(`sections[${sectionIndex}].blocks must be a non-empty array.`);
            return;
        }
        sectionRecord.blocks.forEach((block, blockIndex) => {
            validateGuideBlock(block, {
                changed,
                seen,
                errors,
                path: `sections[${sectionIndex}].blocks[${blockIndex}]`,
            });
        });
    });
    const everythingElse: unknown[] = Array.isArray(guide.everythingElse) ? guide.everythingElse : [];
    everythingElse.forEach((ref, index) => {
        const file = ref && typeof ref === "object" ? (ref as RawGuidedReviewFileReference).file : null;
        if (typeof file !== "string" || !changed.has(file)) {
            errors.push(`everythingElse[${index}].file must reference a changed file.`);
        }
        if (typeof file === "string") seen.add(file);
    });
    const normalizedEverythingElse = [...everythingElse];
    for (const file of changed) {
        if (!seen.has(file)) {
            normalizedEverythingElse.push({ file });
            seen.add(file);
        }
    }
    const widgetAssets: unknown[] = Array.isArray(guide.widgetAssets) ? guide.widgetAssets : [];
    widgetAssets.forEach((asset, index) => validateWidgetAsset(asset, errors, `widgetAssets[${index}]`));
    const normalized = {
        ...guide,
        everythingElse: normalizedEverythingElse,
        widgetAssets,
    };
    return errors.length ? { ok: false, errors } : { ok: true, value: normalized };
}

function validateGuideBlock(block: unknown, ctx: GuideBlockValidationContext) {
    if (!block || typeof block !== "object") {
        ctx.errors.push(`${ctx.path} must be an object.`);
        return;
    }
    const record = block as RawGuidedReviewBlock;
    if (typeof record.type !== "string") {
        ctx.errors.push(`${ctx.path}.type is required.`);
        return;
    }
    if (record.type === "diff") {
        if (typeof record.file !== "string" || !ctx.changed.has(record.file)) {
            ctx.errors.push(`${ctx.path}.file must reference a changed file.`);
        } else ctx.seen.add(record.file);
    } else if (record.type === "mermaid") {
        if (typeof record.source !== "string" || !record.source.trim()) {
            ctx.errors.push(`${ctx.path}.source is required for Mermaid blocks.`);
        }
    } else if (record.type === "widget") {
        if (typeof record.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(record.id)) {
            ctx.errors.push(`${ctx.path}.id must be a safe widget id.`);
        }
        if (record.entry !== undefined && record.entry !== "index.html") {
            ctx.errors.push(`${ctx.path}.entry must be index.html.`);
        }
        if (record.html !== undefined && typeof record.html !== "string") {
            ctx.errors.push(`${ctx.path}.html must be a string.`);
        }
        if (typeof record.html === "string" && /(?:https?:)?\/\//i.test(record.html)) {
            ctx.errors.push(`${ctx.path}.html must not reference external network URLs.`);
        }
        if (Array.isArray(record.assets)) {
            record.assets.forEach((asset, index) =>
                validateWidgetAsset(asset, ctx.errors, `${ctx.path}.assets[${index}]`),
            );
        }
    } else if (!["prose", "callout", "reviewCheckpoint"].includes(record.type)) {
        ctx.errors.push(`${ctx.path}.type is unsupported: ${record.type}.`);
    }
}

function validateWidgetAsset(asset: unknown, errors: string[], path: string) {
    if (!asset || typeof asset !== "object") {
        errors.push(`${path} must be an object.`);
        return;
    }
    const record = asset as RawGuidedReviewWidgetAsset;
    const name = record.name || record.path;
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]{1,120}$/.test(name) || name === "index.html") {
        errors.push(`${path}.name must be a safe local asset filename.`);
    }
    if (typeof record.content !== "string") errors.push(`${path}.content must be a string.`);
    if (
        typeof record.contentType !== "string" ||
        !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;\s*charset=[A-Za-z0-9_-]+)?$/.test(record.contentType)
    ) {
        errors.push(`${path}.contentType must be a safe MIME type.`);
    }
}

function buildChangedFilesMermaid(paths: string[]) {
    if (paths.length === 0) return "flowchart TD\n    A[No changed files detected]";
    const lines = ["flowchart TD", "    A[Review intent] --> B[Core changes]"];
    paths.slice(0, 6).forEach((path, index) => {
        lines.push(`    B --> F${index}[${sanitizeMermaidLabel(path)}]`);
    });
    return lines.join("\n");
}

function sanitizeMermaidLabel(value: string) {
    return value.replace(/[\[\]{}<>]/g, " ").slice(0, 80);
}
