import { readFile } from "node:fs/promises";
import { AGENTS } from "../../constants.js";
import { createSessionRuntime } from "../session/session-runtime.ts";
import { git } from "./git.ts";
export interface ApprovalPublicationState {
    baselineHead?: string;
}
export async function approveAndCommit(cwd: string, signal?: AbortSignal, state: ApprovalPublicationState = {}) {
    const branch = await git(cwd, ["symbolic-ref", "--short", "HEAD"]).catch(() => "");
    if (!branch) return { ok: false, message: "Approve & Commit is unavailable in detached HEAD." };
    const currentHead = await git(cwd, ["rev-parse", "HEAD"]);
    const before = (state.baselineHead ??= currentHead);
    const pendingPush = currentHead !== before && !(await git(cwd, ["status", "--porcelain"]));
    const runtime = createSessionRuntime({ ownerProcessKind: "workspace" });
    const id = await runtime.createPromptReadySession({ cwd, agentName: AGENTS.OPERATOR });
    let turnError = "";
    const cancel = () => {
        void runtime.cancelSession(id);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
        if (signal?.aborted) throw new Error("Approve & Commit canceled.");
        const template = await readFile(new URL("../../prompt-templates/commit.md", import.meta.url), "utf8");
        const result = await runtime.promptSession(id, {
            initialRequest: `${template.replace(/^---\n[\s\S]*?\n---\n/, "")}\n\n${
                pendingPush
                    ? "The reviewed commit already exists and the tree is clean. Push the existing commit; do not create another commit."
                    : "Commit and push these reviewed changes."
            } When this branch has no upstream, use git push -u origin HEAD.`,
            emitInitialEvents: false,
            signal,
        });
        if (!result.ok) turnError = result.error || "Operator failed.";
    } catch (error) {
        turnError = String(error);
    } finally {
        signal?.removeEventListener("abort", cancel);
        await runtime.closeSession(id);
    }
    const failures: string[] = [];
    if (await git(cwd, ["status", "--porcelain"])) failures.push("working tree is not clean");
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    if (head === before) failures.push("HEAD did not move");
    if ((await git(cwd, ["rev-parse", "@{u}"]).catch(() => "")) !== head) {
        failures.push("@{u} does not equal HEAD (push failed or upstream is missing)");
    }
    if (turnError) failures.push(turnError);
    return {
        ok: failures.length === 0,
        message: failures.length
            ? `Approve & Commit failed: ${failures.join("; ")}. Commits remain in place.`
            : "Changes committed and pushed.",
    };
}
