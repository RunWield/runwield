/** Trim the submitted checklist, returning null when it contains only whitespace. */
export function prepareManualQaChecklist(markdown: string): string | null {
    return markdown.trim() || null;
}
