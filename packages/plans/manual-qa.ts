import { EPIC_MANUAL_QA_FILE_NAME } from "./format/artifacts.ts";
import type { ManualQaSection } from "./store.ts";

function marker(child: string, position: "start" | "end"): string {
    const escaped = child.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
    return `<!-- runwield:manual-qa:${position} child="${escaped}" -->`;
}

function validateChecklist(childName: string, checklistMarkdown: string): string {
    const trimmed = String(checklistMarkdown || "").trim();
    const lines = trimmed.split(/\r?\n/);
    if (lines[0]?.trim() !== `Manual verification steps for ${childName}`)
        throw new Error(`Manual QA checklist must start with "Manual verification steps for ${childName}".`);
    const items = lines.filter((line) => /^- \[ \] \S/.test(line.trim()));
    if (items.length < 1 || items.length > 6)
        throw new Error("Manual QA checklist must contain 1 to 6 unchecked checklist items.");
    if (lines.some((line) => /^- \[[xX]\]/.test(line.trim())))
        throw new Error("Manual QA checklist must not contain checked items when generated.");
    return trimmed;
}

export function hasManualQaSection(body: string | null, child: string): boolean {
    return Boolean(body?.includes(marker(child, "start")));
}

/** Add one validated section while keeping user edits and existing checklist state. */
export function prepareManualQaSection(
    existing: string | null,
    epicName: string,
    childName: string,
    childKey: string,
    section: ManualQaSection,
): string | null {
    const checklist = validateChecklist(childName, section.checklistMarkdown);
    if (hasManualQaSection(existing, childKey)) return null;
    if (existing?.includes("runwield:manual-qa:start") && !existing.includes("runwield:manual-qa:end"))
        throw new Error(`Manual QA artifact appears malformed: ${EPIC_MANUAL_QA_FILE_NAME}`);
    const header = `# Manual QA for ${epicName}\n\nThis checklist is advisory. It does not change RunWield verification status.\n`;
    return [
        existing === null ? header : existing.trimEnd(),
        "",
        marker(childKey, "start"),
        `## ${section.childHeading.trim() || childName}`,
        "",
        checklist,
        marker(childKey, "end"),
        "",
    ].join("\n");
}
