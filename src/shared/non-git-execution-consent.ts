import { getCwd } from "../constants.ts";
import { getCustomSetting, setCustomSetting } from "./settings.js";

// Consent uses settings; ordinary Git operations must not load the agent runtime
// that SettingsManager depends on just to inspect or publish a repository.
const NON_GIT_EXECUTION_CONSENT_KEY = "nonGitExecutionConsent";
type NonGitConsentKind = "featurePlan" | "quickFix";

function readConsent(projectRoot: string): Record<string, boolean> {
    const value = getCustomSetting(NON_GIT_EXECUTION_CONSENT_KEY, "project", projectRoot);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function hasNonGitExecutionConsent(kind: NonGitConsentKind, projectRoot = getCwd()): boolean {
    return readConsent(projectRoot)[kind] === true;
}

export async function rememberNonGitExecutionConsent(kind: NonGitConsentKind, projectRoot = getCwd()): Promise<void> {
    await setCustomSetting(
        NON_GIT_EXECUTION_CONSENT_KEY,
        { ...readConsent(projectRoot), [kind]: true },
        "project",
        projectRoot,
    );
}
