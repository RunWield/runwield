import process from "node:process";
import { initRunWieldTheme } from "../theme/theme.js";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { getCwd } from "../../constants.js";
import {
    DIRECTORY_WARNING,
    type DirectoryInspection,
    inspectMissingManagedProjectDirectory,
    inspectProjectDirectory,
} from "../../shared/project-directory.ts";
import { PromptSelectBlock } from "./blocks.js";
import { getTUI, initTUI, stopTUI } from "./tui.ts";

const acknowledgedRoots = new Set<string>();
export class DirectoryStartupCanceled extends Error {}

/** Consent is invocation-local and tied to the resolved directory. */
export async function confirmProjectDirectory(path = getCwd(), allow = false): Promise<boolean> {
    return await confirmInspectedDirectory(inspectProjectDirectory(path), allow);
}

/** Preflight only a missing registered execution target; recheck the restored directory afterwards. */
export async function confirmMissingManagedProjectDirectory(path: string): Promise<boolean> {
    return await confirmInspectedDirectory(inspectMissingManagedProjectDirectory(path), false);
}

async function confirmInspectedDirectory(directory: DirectoryInspection, allow: boolean): Promise<boolean> {
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
            `${DIRECTORY_WARNING}\n${path}\nUse wld --allow-system-directory <command> to continue without terminal input.`,
        );
    }
    initRunWieldTheme();
    const tui = initTUI();
    const block = new PromptSelectBlock(`${DIRECTORY_WARNING}\n${path}`, [
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
