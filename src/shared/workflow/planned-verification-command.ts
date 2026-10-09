/** Retain a full-project command chosen during planning, including without Init. */
import {
    getCustomSetting,
    getExactProjectCustomSetting,
    setCustomSetting,
    setExactProjectCustomSetting,
} from "../settings.js";
import { captureValidationSettingsWrite, recordValidationSettingsWrite } from "../worktree-project-context.ts";

export interface PlannedVerificationCommand {
    command: string;
    intent: "discovered" | "user_selected";
}

export async function rememberPlannedVerificationCommand(
    root: string,
    selection: PlannedVerificationCommand,
): Promise<void> {
    const command = selection.command;
    if (!command.trim()) throw new Error("The full project verification command must not be empty.");
    const exact = getExactProjectCustomSetting("verification_command", root);
    const existing = typeof exact === "string" && exact.trim()
        ? exact
        : getCustomSetting("verification_command", "project", root);
    // Discovery cannot replace a saved preference or a checkout-local repair.
    if (selection.intent !== "user_selected" && typeof existing === "string" && existing.trim()) return;
    if (exact === command && existing === command) return;
    const snapshot = await captureValidationSettingsWrite(root);
    await setCustomSetting("verification_command", command, "project", root);
    setExactProjectCustomSetting("verification_command", command, root);
    await recordValidationSettingsWrite(snapshot, command);
}
