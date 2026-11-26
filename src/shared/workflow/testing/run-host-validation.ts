import { openWorkflow } from "@runwield/workflow";
import type { ValidationHostResume } from "@runwield/workflow/host-contract";

interface RunHostValidationOptions {
    projectRoot: string;
    planName: string;
    resume?: ValidationHostResume;
}

export function runHostValidation({ projectRoot, planName, resume }: RunHostValidationOptions) {
    const workflow = openWorkflow({ cwd: projectRoot, planName });
    if (resume?.kind === "decision") return workflow.answerInteraction(resume);
    if (resume) return workflow.continueHostValidation(resume);
    return workflow.advanceHostValidation();
}
