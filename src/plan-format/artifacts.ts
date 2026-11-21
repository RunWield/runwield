/** Storage-free names and classification for Plan companion documents. */
export const EPIC_MANUAL_QA_FILE_NAME = "manual-qa.md";
/** The latest failing Epic integration gate report; a repair child is planned from it. */
export const EPIC_INTEGRATION_REPORT_FILE_NAME = "integration-report.md";
export const EPIC_ARTIFACT_FILE_NAMES = Object.freeze([EPIC_MANUAL_QA_FILE_NAME, EPIC_INTEGRATION_REPORT_FILE_NAME]);
const EPIC_ARTIFACT_PLAN_SEGMENTS = new Set(EPIC_ARTIFACT_FILE_NAMES.map((fileName) => fileName.replace(/\.md$/, "")));

export function splitPlanName(planName: string): string[] {
    return String(planName || "")
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean);
}

export function isEpicArtifactPlanName(planName: string): boolean {
    const segments = splitPlanName(planName.replace(/\.md$/i, ""));
    return segments.length === 2 && EPIC_ARTIFACT_PLAN_SEGMENTS.has(segments[1]);
}

export function isEpicArtifactPlanPath(path: string): boolean {
    const normalized = path.replaceAll("\\", "/");
    const parts = normalized.split("/");
    const docsIndex = parts.lastIndexOf("docs");
    if (docsIndex < 0 || parts[docsIndex + 1] !== "plans") return false;
    const rest = parts.slice(docsIndex + 2);
    return rest.length === 2 && EPIC_ARTIFACT_FILE_NAMES.includes(rest[1]);
}

export function assertNotReservedEpicArtifactPlanName(planName: string): void {
    if (!isEpicArtifactPlanName(planName)) return;
    throw new Error(`${planName} is reserved for an Epic Artifact. Choose a different child Plan name and call again.`);
}
