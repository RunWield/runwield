import process from "node:process";
import { Key, matchesKey, TuiAltScreen } from "@earendil-works/pi-tui";
import { initRunWieldTheme } from "../theme/theme.js";
import { PromptSelectBlock } from "./blocks.js";
import { getTUI, initTUI, stopTUI } from "./tui.ts";
import {
    ProjectIdentityEntryRequired,
    admitProjectIdentity,
    type ProjectCloneChoice,
    type ProjectIdentityPending,
} from "../../shared/project-identity.ts";

/** Interactive action admission leaves runtime preparation to the action's existing owner. */
export async function admitProjectWithIdentityChoice(root: string): Promise<boolean> {
    let choice: ProjectCloneChoice | undefined;
    for (;;) {
        const result = await admitProjectIdentity(root, { choice });
        if (result.kind === "existing") return true;
        if (result.kind !== "pending") throw new ProjectIdentityEntryRequired(result);
        choice = await chooseProject(result);
        if (choice.kind === "cancel") return false;
    }
}
async function chooseProject(pending: ProjectIdentityPending): Promise<ProjectCloneChoice> {
    let existingTui = false;
    try {
        getTUI();
        existingTui = true;
    } catch {
        /* Startup has not opened a terminal. */
    }
    if (!existingTui && !process.stdin.isTTY) throw new ProjectIdentityEntryRequired(pending);
    initRunWieldTheme();
    const tui = initTUI();
    const previousFocus = tui instanceof TuiAltScreen ? tui.getFocusedComponent() : null;
    const block = new PromptSelectBlock(
        "This clone matches known Projects. Link it to a Project or keep it separate?",
        [
            { value: "cancel", label: "Cancel" },
            { value: "new", label: "Create a separate Project" },
            ...pending.candidates.map((candidate) => ({
                value: candidate.projectId,
                label: `${candidate.displayName} (${candidate.projectId})`,
            })),
        ],
    );
    let removeListener: (() => void) | undefined;
    let closed: (() => void) | undefined;
    try {
        const selected = await new Promise<string>((resolve) => {
            closed = () => resolve("cancel");
            process.stdin.on("end", closed);
            process.stdin.on("close", closed);
            if (process.stdin.readableEnded || process.stdin.destroyed) resolve("cancel");
            block.list.onSelect = (item) => resolve(item.value);
            block.list.onCancel = closed;
            removeListener = tui.addInputListener((data) => {
                if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
                    resolve("cancel");
                    return { consume: true };
                }
            });
            tui.addChild(block);
            tui.setFocus(block);
            tui.requestRender();
        });
        return {
            kind: selected === "cancel" ? "cancel" : selected === "new" ? "new" : "link",
            candidates: pending.candidates,
            ...(selected !== "cancel" && selected !== "new" ? { projectId: selected } : {}),
        };
    } finally {
        if (closed) {
            process.stdin.off("end", closed);
            process.stdin.off("close", closed);
        }
        removeListener?.();
        tui.removeChild(block);
        if (!existingTui) stopTUI();
        else {
            tui.setFocus(previousFocus);
            tui.requestRender();
        }
    }
}
