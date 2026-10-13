import { captureForegroundProcess } from "./captured-process.ts";
/** Recover formatting-only drift left by older controller writes after sealing. */
import { extractYaml } from "./front-matter.ts";
import { isDeepStrictEqual } from "node:util";
import {
    loadPlanStrict,
    planDocumentMarkdown,
    splitPlanMarkdownBody,
    withPlanLock,
    writePlanMarkdownWithRevision,
} from "../plan-store.js";

type FormattingRecovery = {
    executionCwd: string;
    sealedExecutionCommit: string;
    allowedPlanPaths: string[];
};

function differsOnlyInFormatting(sealed: string, current: string): boolean {
    try {
        if (sealed === current || planDocumentMarkdown(sealed) !== sealed) return false;
        if (splitPlanMarkdownBody(sealed).body !== splitPlanMarkdownBody(current).body) return false;
        // Compare every stored key, including extension fields. Parsed Plan
        // defaults must never hide a substantive edit from this proof.
        return isDeepStrictEqual(extractYaml(sealed).attrs, extractYaml(current).attrs);
    } catch {
        // Missing or malformed front matter is not a formatting repair. Leave
        // it untouched for the normal sealed-candidate guard to reject.
        return false;
    }
}

export async function recoverSealedPlanFormatting(args: FormattingRecovery): Promise<void> {
    for (const path of args.allowedPlanPaths) {
        if (!path.startsWith("docs/plans/") || !path.endsWith(".md")) continue;
        const planName = path.slice("docs/plans/".length, -3);
        await withPlanLock(args.executionCwd, planName, async () => {
            const git = (command: string[]) =>
                captureForegroundProcess("git", { cwd: args.executionCwd, args: command });
            // Never rewrite commits or the user's staged changes. The only repair
            // here is an unstaged serialization change to the exact sealed Plan.
            if (!(await git(["diff", "--quiet", args.sealedExecutionCommit, "HEAD", "--", path])).success) return;
            if (!(await git(["diff", "--cached", "--quiet", "--", path])).success) return;
            const current = await loadPlanStrict(args.executionCwd, planName);
            if (current.kind !== "loaded") return;
            const blob = await git(["show", `${args.sealedExecutionCommit}:${path}`]);
            if (!blob.success) return;
            const sealed = new TextDecoder().decode(blob.stdout);
            if (!differsOnlyInFormatting(sealed, current.markdown)) return;
            await writePlanMarkdownWithRevision(current.path, sealed, current.revision);
        });
    }
}
