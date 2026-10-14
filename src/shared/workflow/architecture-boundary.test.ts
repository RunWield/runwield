import { assertEquals } from "../../testing/assertions.ts";
import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath as fromFileUrl } from "node:url";

import ts from "typescript";

const REPO_ROOT = join(dirname(fromFileUrl(import.meta.url)), "../../..");

function repoPath(path: string): string {
    return join(REPO_ROOT, path);
}

const PLAN_RECOVERY_FILES = [
    "src/cmd/load-plan/plan-recovery-flow.ts",
    "src/cmd/load-plan/plan-recovery-actions.ts",
    "src/cmd/load-plan/plan-recovery-reset.ts",
];

const HIGH_LEVEL_FILES = [
    "src/shared/workflow/workflow.js",
    "src/shared/workflow/execution-start.ts",
    "src/shared/workflow/implementation-checkpoint.ts",
    "src/shared/workflow/plan-executor.ts",
    "src/shared/workflow/validation.ts",
    "src/shared/workflow/validation-engine.ts",
    "src/shared/workflow/validation-mechanical.ts",
    "src/shared/workflow/validation-semantic.ts",
    "src/shared/workflow/validation-human-review.ts",
    "src/shared/workflow/validation-publication.ts",
    "src/shared/workflow/validation-merge-repair.ts",
    "src/cmd/load-plan/index.ts",
    ...PLAN_RECOVERY_FILES,
    "src/ui/workspace/server/plan-adapter.js",
];

const RAW_LIFECYCLE_PATTERNS: [string, RegExp][] = [
    ["updatePlanStatus", /updatePlanStatus\s*\(/],
    ["unscoped updatePlanFrontMatter", /updatePlanFrontMatter\s*\(/],
];

function isInsideSemanticTransitionApply(text: string, index: number): boolean {
    const window = text.slice(Math.max(0, index - 5000), index);
    return /run(?:Recovery|ValidationOutcome|ExecutionPreparation|ImplementationCheckpoint|Archive|PlanFrontMatter|ReviewReopen|PlanLifecycleEvent|PlanReviewDecision)Transition\s*\([\s\S]*(?:recover|settle|prepare|checkpoint|move|reopen|record|decide|apply)\s*:\s*async/.test(
        window,
    );
}

test("high-level lifecycle callers use Plan Lifecycle APIs instead of raw Plan status writes", async () => {
    const offenders: string[] = [];
    for (const file of HIGH_LEVEL_FILES) {
        const text = await fsReadFile(repoPath(file), "utf8");
        for (const [label, pattern] of RAW_LIFECYCLE_PATTERNS) {
            for (const match of text.matchAll(new RegExp(pattern.source, "g"))) {
                const index = match.index ?? 0;
                if (label === "unscoped updatePlanFrontMatter") {
                    const priorLine = text.slice(Math.max(0, index - 120), index);
                    if (/updatePlanFrontMatter\s*!==\s*updatePlanFrontMatterFn/.test(priorLine)) continue;
                    if (isInsideSemanticTransitionApply(text, index)) continue;
                }
                offenders.push(`${file}: ${label}`);
            }
        }
    }
    assertEquals(offenders, []);
});

test("Git publication uses the durable publication machine instead of recovery actions", async () => {
    const publication = await fsReadFile(repoPath("src/shared/workflow/validation-publication.ts"), "utf8");
    const recovery = (await Promise.all(PLAN_RECOVERY_FILES.map((file) => fsReadFile(repoPath(file), "utf8")))).join(
        "\n",
    );
    assertEquals(publication.includes("startPublicationAttempt"), true);
    assertEquals(publication.includes("advanceStoredPublication"), true);
    assertEquals(publication.includes("reconcileStoredPublication"), true);
    assertEquals(recovery.includes("mergeExecutionWorktree("), false);
});

test("transition wrappers expose expected revision preconditions for lifecycle writers", async () => {
    const text = await fsReadFile(repoPath("src/shared/workflow/state-transition.ts"), "utf8");
    const wrappers = [
        "runPlanLifecycleEventTransition",
        "runPlanReviewDecisionTransition",
        "runReviewReopenTransition",
        "runPlanFrontMatterTransition",
        "runExecutionPreparationTransition",
        "runValidationOutcomeTransition",
        "runRecoveryTransition",
        "runArchiveTransition",
    ];
    const offenders = wrappers.filter((name) => {
        const start = text.indexOf(`export async function ${name}`);
        if (start === -1) return true;
        const body = text.slice(start, text.indexOf("\n}\n", start) + 3);
        return !/expectedRevision/.test(body);
    });
    assertEquals(offenders, []);
});

test("Agent Plan creation uses create-if-absent instead of rename-over writes", async () => {
    const text = await fsReadFile(repoPath("src/tools/plan-safe-file-tools.ts"), "utf8");
    assertEquals(/atomicWriteTextFileIfAbsent\s*\(/.test(text), true);
    assertEquals(/atomicWriteTextFile\s*\(/.test(text), false);
});

/** Includes static imports, re-exports, dynamic imports, and import-type expressions. */
function importSpecifiers(text: string, file: string): string[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    function visit(node: ts.Node): void {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            imports.push(node.moduleSpecifier.text);
        }
        if (
            ts.isImportTypeNode(node) &&
            ts.isLiteralTypeNode(node.argument) &&
            ts.isStringLiteral(node.argument.literal)
        ) {
            imports.push(node.argument.literal.text);
        }
        if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0])
        ) {
            imports.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    return imports;
}

async function moduleGraphOffenders(root: string, forbidden: RegExp): Promise<string[]> {
    const pending = [repoPath(root)];
    const visited = new Set<string>();
    const offenders = new Set<string>();
    while (pending.length) {
        const file = pending.pop()!;
        if (visited.has(file)) continue;
        visited.add(file);
        if (forbidden.test(file)) offenders.add(file);
        const text = await fsReadFile(file, "utf8");
        for (const specifier of importSpecifiers(text, file)) {
            if (forbidden.test(specifier)) offenders.add(specifier);
            if (specifier.startsWith("node:") || specifier.startsWith("bun:")) continue;
            const resolved = Bun.resolveSync(specifier, dirname(file));
            if (/\.[cm]?[jt]sx?$/.test(resolved)) pending.push(resolved);
        }
    }
    return [...offenders].sort();
}

test("pure review diff graph excludes Pi, the tool wrapper, and HostedSession", async () => {
    assertEquals(
        await moduleGraphOffenders(
            "src/shared/workflow/review-diff.ts",
            /@earendil-works\/|review-diff-tool\.js$|hosted-session\.js$/,
        ),
        [],
    );
});

test("pure review outcome graph excludes Pi, the completion tool, and HostedSession", async () => {
    assertEquals(
        await moduleGraphOffenders(
            "src/shared/workflow/review-outcome.ts",
            /@earendil-works\/|tools\/review-complete\.ts$|hosted-session\.js$/,
        ),
        [],
    );
});

test("validation supervisor does not import Session composition", async () => {
    const file = repoPath("src/shared/workflow/validation-supervisor.ts");
    const imports = importSpecifiers(await fsReadFile(file, "utf8"), file);
    assertEquals(
        imports.filter((specifier) =>
            /(?:^|\/)(?:validation\.ts|validation-session-adapter\.ts|hosted-session\.js)$/.test(specifier),
        ),
        [],
    );
});

test("host-turn composition has no validation policy, CI invocation, or model construction", async () => {
    const text = await fsReadFile(repoPath("src/shared/workflow/validation-host-turn.ts"), "utf8");
    assertEquals(
        /\b(?:runValidationLoop|applyRoundFindings|unaccountedOpenItems|decideValidationRecovery|recordLifecycleEvent|recordDeliveryEvidence|runValidationCommand|runLocalCI|createAgentSession|createValidationSessionPort)\s*\(/.test(
            text,
        ),
        false,
    );
    assertEquals(/new\s+(?:HostedSession|AgentSession)\s*\(/.test(text), false);
    assertEquals(/\brunValidationAttempt\s*\(/.test(text), true);
});
