import { projects, type DirectoryInspection } from "@runwield/projects";
import process from "node:process";
import { initRunWieldTheme } from "../theme/theme.ts";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { getCwd } from "../../constants.ts";
import { PromptSelectBlock } from "./blocks.ts";
import { getTUI, initTUI, stopTUI } from "./tui.ts";

const acknowledgedRoots = new Set<string>();
export class DirectoryStartupCanceled extends Error {}

/** Consent is invocation-local and tied to the resolved directory. */
export async function confirmProjectDirectory(
    path = getCwd(),
    allow = false,
    startupNotice?: string,
): Promise<boolean> {
    return await confirmInspectedDirectory(projects.directory.inspect(path), allow, startupNotice);
}

/** Preflight only a missing registered execution target; recheck the restored directory afterwards. */
export async function confirmMissingManagedProjectDirectory(path: string): Promise<boolean> {
    return await confirmInspectedDirectory(projects.directory.inspectMissingManaged(path), false);
}

async function confirmInspectedDirectory(
    directory: DirectoryInspection,
    allow: boolean,
    startupNotice?: string,
): Promise<boolean> {
    const path = directory.enteredRoot;
    if (!directory.classified) return true;
    const key = directory.canonicalRoot;
    if (allow || acknowledgedRoots.has(key)) {
        acknowledgedRoots.add(key);
        return true;
    }
    let existingTui = false;
    try {
        getTUI();
        existingTui = true;
    } catch {
        /* No terminal has been opened yet. */
    }
    if (!existingTui && !process.stdin.isTTY) {
        throw new Error(
            `${projects.directory.warning}\n${path}\nUse wld --allow-system-directory <command> to continue without terminal input.`,
        );
    }
    initRunWieldTheme();
    const tui = initTUI();
    const warning = `${projects.directory.warning}\n${path}`;
    const block = new PromptSelectBlock(startupNotice ? `${startupNotice}\n\n${warning}` : warning, [
        { value: "quit", label: "Quit" },
        { value: "continue", label: "Continue" },
    ]);
    let removeListener: (() => void) | undefined;
    let onInputClosed: (() => void) | undefined;
    try {
        const continued = await new Promise<boolean>((resolve) => {
            onInputClosed = () => resolve(false);
            process.stdin.on("end", onInputClosed);
            process.stdin.on("close", onInputClosed);
            if (process.stdin.readableEnded || process.stdin.destroyed) resolve(false);
            block.list.onSelect = (item) => resolve(item.value === "continue");
            block.list.onCancel = () => resolve(false);
            removeListener = tui.addInputListener((data) => {
                if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.ctrl("d"))) {
                    resolve(false);
                    return { consume: true };
                }
            });
            tui.addChild(block);
            tui.setFocus(block);
            tui.requestRender();
        });
        if (continued) acknowledgedRoots.add(key);
        return continued;
    } finally {
        if (onInputClosed) {
            process.stdin.off("end", onInputClosed);
            process.stdin.off("close", onInputClosed);
        }
        removeListener?.();
        tui.removeChild(block);
        if (!existingTui) stopTUI();
        else tui.requestRender();
    }
}
