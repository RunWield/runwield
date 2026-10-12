import {
    getCodeReviewMode,
    getCustomSetting,
    getGuidedReviewMode,
    setCustomSetting,
    shouldAutoMergePlansIntoTargetBranch,
} from "../../shared/settings.js";

interface PolicyOption {
    value: string;
    label: string;
    description?: string;
}

interface PolicyUi {
    promptSelect(title: string, options: PolicyOption[]): Promise<string | null>;
    appendSystemMessage(message: string): void;
    requestRender?(): void;
}

interface PolicySetting {
    key: "codereview" | "guidedReview" | "defaultProjectTrust" | "plans.autoMergeIntoTargetBranch";
    title: string;
    current: string;
    description: string;
    globalOnly?: boolean;
    choices: PolicyOption[];
}

/** Existing policy values only; Never is the user-facing label for stored `none`. */
export function getPolicySettings(projectRoot: string): PolicySetting[] {
    const trust = getCustomSetting("defaultProjectTrust", "global", projectRoot);
    return [
        {
            key: "codereview",
            title: "Code review",
            current: getCodeReviewMode(projectRoot),
            description: "Human review after automated checks, before merging",
            choices: [
                { value: "ask", label: "Ask", description: "Offer code review before merging (default)" },
                { value: "always", label: "Always", description: "Require code review before merging" },
                { value: "none", label: "Never", description: "Merge after automated validation without this gate" },
            ],
        },
        {
            key: "guidedReview",
            title: "Guided review",
            current: getGuidedReviewMode(projectRoot),
            description: "Generate an explanation inside code review",
            choices: [
                { value: "auto", label: "Auto", description: "Generate when the review warrants it (default)" },
                { value: "ask", label: "Ask" },
                { value: "always", label: "Always" },
                { value: "none", label: "Never", description: "Manual generation remains available" },
            ],
        },
        {
            key: "plans.autoMergeIntoTargetBranch",
            title: "Auto-merge into target branch",
            current: String(shouldAutoMergePlansIntoTargetBranch(projectRoot)),
            description: "Standalone Plans deliver to a Plan Branch when off; Epic children are unchanged",
            choices: [
                { value: "false", label: "Off (default)", description: "Deliver to plan/<plan-name>" },
                { value: "true", label: "On", description: "Merge into targetBranch (repository default when unset)" },
            ],
        },
        {
            key: "defaultProjectTrust",
            title: "Default project trust",
            current: trust === "always" || trust === "never" ? trust : "ask",
            description: "Global project trust preference",
            globalOnly: true,
            choices: [
                { value: "ask", label: "Ask (default)" },
                { value: "always", label: "Always trust" },
                { value: "never", label: "Never trust automatically" },
            ],
        },
    ];
}

export async function editPolicySetting(policy: PolicySetting, projectRoot: string, ui: PolicyUi): Promise<void> {
    const scope = policy.globalOnly ? "global" : await ui.promptSelect(`Save ${policy.title.toLowerCase()} for`, [
        { value: "project", label: "This project", description: "Overrides your global preference here" },
        { value: "global", label: "All projects", description: "Existing project overrides stay in effect" },
    ]);
    if (scope !== "project" && scope !== "global") return;
    const selection = await ui.promptSelect(
        policy.title,
        policy.choices.map((choice) => ({
            ...choice,
            label: `${choice.label}${choice.value === policy.current ? " (current)" : ""}`,
        })),
    );
    if (!policy.choices.some((choice) => choice.value === selection)) return;
    const isPlanMergePolicy = policy.key === "plans.autoMergeIntoTargetBranch";
    if (isPlanMergePolicy) {
        const plans = getCustomSetting("plans", scope, projectRoot);
        await setCustomSetting(
            "plans",
            {
                ...(plans && typeof plans === "object" && !Array.isArray(plans) ? plans : {}),
                autoMergeIntoTargetBranch: selection === "true",
            },
            scope,
            projectRoot,
        );
    } else {
        await setCustomSetting(policy.key, selection, scope, projectRoot);
    }
    const label = policy.choices.find((choice) => choice.value === selection)!.label;
    const overridden = scope === "global" && !policy.globalOnly &&
        (isPlanMergePolicy
            ? getCustomSetting("plans", "project", projectRoot)?.autoMergeIntoTargetBranch !== undefined
            : getCustomSetting(policy.key, "project", projectRoot) !== undefined);
    ui.appendSystemMessage(
        `${policy.title}: ${label} (${scope}).${
            overridden ? " This project's explicit override remains in effect." : ""
        }`,
    );
    ui.requestRender?.();
}
