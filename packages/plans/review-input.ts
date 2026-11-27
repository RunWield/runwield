import { createHash } from "node:crypto";
import type { ProjectStoreIdentity } from "@runwield/projects";
import type { PlanFrontMatter } from "./document.ts";
import type { PackageDocument, PackageDocuments } from "./package-data.ts";
import { reviewSourceStillMatches, sameReviewedMarkdown } from "./review-markdown.ts";
import {
    readPlanPackageInput,
    type LoadedPlanPackage,
    type PackageDefinition,
    type PackageWorkflowInput,
} from "./package-storage.ts";

type ReviewedDefinition = Pick<LoadedPlanPackage["metadata"], "definition" | "parentPlanId" | "dependencyPlanIds">;
interface ReviewedContextEdit {
    planId: string;
    text: string;
}

export type ReviewDocumentEquivalence =
    | { kind: "markdown" }
    | { kind: "sequence"; frontMatter: PlanFrontMatter; editedContexts?: readonly ReviewedContextEdit[] };

export type ReviewInputComparison =
    ReviewDocumentEquivalence | { kind: "captured-context"; planId: string; retained: string; live: string };

/** Preserve the serialization and member order of persisted review digests. */
export function definitionHash(packages: readonly LoadedPlanPackage[], ignoreCompletion = true): string {
    return createHash("sha256")
        .update(
            JSON.stringify(
                packages.map(({ metadata }) => {
                    const { status: _status, ...definition } = metadata.definition;
                    if (ignoreCompletion) {
                        delete definition.epicCompletionMode;
                        delete definition.epicDoneEnoughAt;
                        delete definition.epicDoneEnoughSummary;
                    }
                    return {
                        planId: metadata.planId,
                        definition,
                        parentPlanId: metadata.parentPlanId,
                        dependencyPlanIds: metadata.dependencyPlanIds,
                    };
                }),
            ),
        )
        .digest("hex");
}
function reviewedDefinitionChanged(current: LoadedPlanPackage, next: ReviewedDefinition) {
    return definitionHash([current]) !== definitionHash([{ ...current, metadata: { ...current.metadata, ...next } }]);
}

/** Rebind only the selected definition, preserving the frozen documents and family order. */
export function reviewInputWithDefinition(
    input: PackageWorkflowInput,
    packages: LoadedPlanPackage[],
    definition: PackageDefinition,
): PackageWorkflowInput {
    return {
        ...input,
        definitionHash: definitionHash(
            packages.map((plan, index) =>
                index === 0 ? { ...plan, metadata: { ...plan.metadata, definition } } : plan,
            ),
        ),
    };
}

export function assertReviewedDefinition(packages: LoadedPlanPackage[], input: PackageWorkflowInput): void {
    // Accept legacy full-definition digests; new inputs omit Core-authored completion facts.
    if (
        (input.definitionHash !== definitionHash(packages) &&
            input.definitionHash !== definitionHash(packages, false)) ||
        input.inputs.length !== packages.length
    ) {
        throw new Error("Required Plan definition or membership changed; review the current input.");
    }
}

function matchesReviewedDocument(
    before: PackageDocument,
    live: PackageDocument,
    planId: string,
    comparison: ReviewInputComparison | undefined,
): boolean {
    if (before.hash === live.hash) return true;
    if (!comparison) return false;
    const decoder = new TextDecoder();
    const retainedText = decoder.decode(before.bytes);
    const liveText = decoder.decode(live.bytes);
    switch (comparison.kind) {
        case "markdown":
            return sameReviewedMarkdown(retainedText, liveText);
        case "sequence": {
            const edited =
                live.name === "context.md" && comparison.editedContexts?.find((edit) => edit.planId === planId);
            return edited
                ? liveText === edited.text
                : reviewSourceStillMatches(
                      { attrs: comparison.frontMatter, body: liveText },
                      comparison.frontMatter,
                      retainedText,
                  );
        }
        case "captured-context":
            return (
                live.name === "context.md" &&
                planId === comparison.planId &&
                retainedText === comparison.retained &&
                liveText === comparison.live
            );
    }
}

/** Compare retained documents, allowing only the recorded review edits and the attempt's generated artifact. */
export async function assertReviewedDocuments(
    identity: ProjectStoreIdentity,
    packages: LoadedPlanPackage[],
    owner: LoadedPlanPackage,
    input: PackageWorkflowInput,
    comparison?: ReviewInputComparison,
): Promise<void> {
    const generated = owner.metadata.workflow?.generatedArtifact;
    const artifact =
        (generated?.reusedByAttemptId ?? generated?.attemptId) === owner.metadata.workflow?.attempt?.attemptId
            ? generated
            : undefined;
    for (const plan of packages) {
        const reference = input.inputs.find((ref) => ref.planId === plan.metadata.planId);
        if (!reference) throw new Error("Required parent input is missing.");
        const retained = await readPlanPackageInput(identity, reference);
        if (
            retained.documents.length +
                (artifact?.planId === plan.metadata.planId &&
                artifact.beforeHash === null &&
                !retained.documents.some((doc) => doc.name === artifact.name) &&
                plan.documents.some((doc) => doc.name === artifact.name && doc.hash === artifact.hash)
                    ? 1
                    : 0) !==
                plan.documents.length ||
            plan.documents.some((doc) => {
                const before = retained.documents.find((prior) => prior.name === doc.name);
                if (
                    artifact?.planId === plan.metadata.planId &&
                    doc.name === artifact.name &&
                    (before?.hash ?? null) === artifact.beforeHash &&
                    doc.hash === artifact.hash
                )
                    return false;
                return !before || !matchesReviewedDocument(before, doc, plan.metadata.planId, comparison);
            })
        )
            throw new Error("Required Plan documents changed; review the current input.");
    }
}

interface ReviewedDocumentEdit {
    previous: string;
    next: string;
}

export type PackageReviewChange =
    | { kind: "edit"; definition?: ReviewedDefinition; documents?: ReviewedDocumentEdit[] }
    | { kind: "restore"; before: PackageDocuments; documents: PackageDocuments }
    | { kind: "review-commit" };

export function changesReviewedInput(plan: LoadedPlanPackage, change: PackageReviewChange): boolean {
    switch (change.kind) {
        case "edit":
            return (
                (change.definition !== undefined && reviewedDefinitionChanged(plan, change.definition)) ||
                (change.documents?.some(({ previous, next }) => !sameReviewedMarkdown(previous, next)) ?? false)
            );
        case "restore":
            return (
                Object.keys(change.before).length !== Object.keys(change.documents).length ||
                plan.documents.some(({ name }) => {
                    const restored = change.documents[name];
                    return restored === undefined || !sameReviewedMarkdown(change.before[name]!, restored);
                })
            );
        case "review-commit":
            // Recovery needs the reopened state if the edited context lands before approval metadata.
            return true;
    }
}
