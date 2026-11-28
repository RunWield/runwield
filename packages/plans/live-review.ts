import { randomUUID } from "node:crypto";
import { isPlanId, type PlanId } from "@runwield/plan-storage-format";
import type { ProjectId, ProjectIdentity } from "@runwield/projects";
import type { PlanFrontMatter } from "./document.ts";
import type { PlanReviewVersion, PlanWorktreeExpectation, SequenceReviewPresentation } from "./lifecycle.ts";
import type { PackageWorkflowInput } from "./package-storage.ts";
import { reviewSourceStillMatches } from "./review-markdown.ts";
import { operationDigest } from "./operation-receipts.ts";

export interface SharedPlanReviewEvidence {
    planId: string;
    runwieldSessionId?: string;
    status: string;
    worktree: PlanWorktreeExpectation;
}

export interface IndividualReviewSource {
    packageInput?: PackageWorkflowInput;
    cwd: string;
    planName: string;
    planPath: string;
    planWithFrontMatter: string;
    planRevision: string;
    expectedControllerRevision?: number;
    originalAttrs: PlanFrontMatter;
    trustedClassification?: PlanFrontMatter["classification"];
    trustedWorkKind?: PlanFrontMatter["workKind"];
    expectedSessionId?: string;
    reviewEvidence?: SharedPlanReviewEvidence;
}

export interface SequenceReviewDocument extends Omit<SequenceReviewPresentation, "body"> {
    packageInput?: PackageWorkflowInput;
}

export function sequenceReviewMatchesDisplay(
    current: SequenceReviewDocument[],
    displayed: readonly Omit<SequenceReviewDocument, "packageInput">[],
): boolean {
    return (
        current.length > 0 &&
        current.length === displayed.length &&
        current.every((doc, index) => {
            const observed = displayed[index];
            return (
                doc.planId === observed.planId &&
                doc.revision === observed.revision &&
                doc.plan === observed.plan &&
                doc.executionAgent === observed.executionAgent &&
                doc.collaborationRecommendation === observed.collaborationRecommendation &&
                reviewSourceStillMatches(
                    { attrs: doc.frontmatter, body: doc.plan },
                    observed.frontmatter,
                    observed.plan,
                )
            );
        })
    );
}

export interface ReviewSourceOwner {
    projectId: ProjectId;
    personalOwner: string;
    executionAccountHome: string;
    repositoryId: string;
}

/** Used by the private Session connection between same-account processes. */
export interface SerializedPlanReviewVersion {
    operationId: string;
    owner: ReviewSourceOwner;
    cwd: string;
    planId: PlanId;
    revision: string;
    runwieldSessionId?: string;
    retainedCheckout?: ProjectIdentity;
    source:
        | { kind: "individual"; review: IndividualReviewSource }
        | { kind: "sequence"; documents: SequenceReviewDocument[] };
}

interface LegacyReviewedPlanSource {
    planName?: string;
    path: string;
    markdown: string;
    revision: string;
    attrs: PlanFrontMatter;
}

/** Review evidence emitted by an older live Session host on the private owner socket. */
export interface LegacyPlanReviewMetadata {
    cwd?: string;
    planId?: string;
    reviewContainerPlanId?: string;
    planName?: string;
    classification?: PlanFrontMatter["classification"];
    triageMeta?: Partial<PlanFrontMatter>;
    expectedRevision?: string;
    expectedStatus?: string;
    expectedWorktree?: PlanWorktreeExpectation;
    packageInput?: PackageWorkflowInput;
    reviewedSource?: LegacyReviewedPlanSource;
    sequenceDocuments?: SequenceReviewDocument[];
}

export function decodeLegacyPlanReviewSource(
    meta: LegacyPlanReviewMetadata,
    owner: ReviewSourceOwner,
    runwieldSessionId: string,
    interactionId?: string,
): SerializedPlanReviewVersion | undefined {
    const { cwd, reviewedSource, expectedRevision, expectedStatus, expectedWorktree, packageInput } = meta;
    const planId = meta.reviewContainerPlanId || meta.planId || meta.triageMeta?.planId;
    if (!cwd || !isPlanId(planId)) return undefined;
    const hash = operationDigest(
        JSON.stringify({
            owner,
            runwieldSessionId,
            interactionId,
            planId,
            expectedRevision,
            reviewedSource,
            sequence: meta.sequenceDocuments,
        }),
    );
    const operationId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    if (Array.isArray(meta.sequenceDocuments)) {
        const documents = meta.sequenceDocuments;
        const parent = documents[0];
        if (
            parent?.planId !== planId ||
            !parent.revision ||
            (expectedRevision && expectedRevision !== parent.revision) ||
            new Set(documents.map((document) => document.planId)).size !== documents.length ||
            documents.some(
                (doc) =>
                    !isPlanId(doc.planId) ||
                    doc.frontmatter?.planId !== doc.planId ||
                    !doc.revision ||
                    typeof doc.plan !== "string" ||
                    doc.packageInput?.inputs?.[0]?.planId !== doc.planId,
            )
        )
            return undefined;
        return {
            operationId,
            owner,
            cwd,
            planId,
            revision: parent.revision,
            runwieldSessionId,
            source: { kind: "sequence", documents },
        };
    }
    if (
        !reviewedSource ||
        reviewedSource.attrs?.planId !== planId ||
        reviewedSource.revision !== expectedRevision ||
        !expectedRevision ||
        !expectedStatus ||
        reviewedSource.attrs.status !== expectedStatus ||
        !expectedWorktree ||
        !reviewedSource.path ||
        typeof reviewedSource.markdown !== "string" ||
        packageInput?.inputs?.[0]?.planId !== planId
    )
        return undefined;
    const planName = reviewedSource.planName || meta.planName;
    if (!planName) return undefined;
    return {
        operationId,
        owner,
        cwd,
        planId,
        revision: expectedRevision,
        runwieldSessionId,
        source: {
            kind: "individual",
            review: {
                cwd,
                planName,
                planPath: reviewedSource.path,
                planWithFrontMatter: reviewedSource.markdown,
                planRevision: expectedRevision,
                originalAttrs: reviewedSource.attrs,
                trustedClassification:
                    meta.classification || meta.triageMeta?.classification || reviewedSource.attrs.classification,
                trustedWorkKind: reviewedSource.attrs.workKind,
                expectedSessionId: runwieldSessionId,
                reviewEvidence: { planId, runwieldSessionId, status: expectedStatus, worktree: expectedWorktree },
                packageInput,
            },
        },
    };
}

interface AppliedReview<Result> {
    decision: string;
    result: Promise<Result>;
}

interface RetainedReviewVersion<Result> {
    version: SerializedPlanReviewVersion;
    application?: AppliedReview<Result>;
}

function sameReviewOwner(expected: ReviewSourceOwner, actual: ReviewSourceOwner | undefined): boolean {
    return Boolean(
        actual &&
        expected.projectId === actual.projectId &&
        expected.personalOwner === actual.personalOwner &&
        expected.executionAccountHome === actual.executionAccountHome &&
        expected.repositoryId === actual.repositoryId,
    );
}

/** Retain reviewed source and coalesce replays while an interaction references it. */
export class RetainedPlanReviewVersions<Result> {
    #versions = new WeakMap<PlanReviewVersion, RetainedReviewVersion<Result>>();

    retain(version: Omit<SerializedPlanReviewVersion, "operationId"> & { operationId?: string }): PlanReviewVersion {
        const reference = Object.freeze({ planId: version.planId, revision: version.revision }) as PlanReviewVersion;
        this.#versions.set(reference, {
            version: structuredClone({ ...version, operationId: version.operationId ?? randomUUID() }),
        });
        return reference;
    }

    serialize(reference: PlanReviewVersion): SerializedPlanReviewVersion | undefined {
        const retained = this.#versions.get(reference);
        return retained && structuredClone(retained.version);
    }

    restore(version: SerializedPlanReviewVersion, runwieldSessionId: string): PlanReviewVersion | undefined {
        if (!version?.runwieldSessionId || version.runwieldSessionId !== runwieldSessionId) return undefined;
        if (
            !isPlanId(version.planId) ||
            !version.revision ||
            !version.owner ||
            !/^[a-f0-9-]{36}$/.test(version.operationId)
        )
            return undefined;
        const retained = version.retainedCheckout;
        if (
            retained &&
            !sameReviewOwner(version.owner, { ...retained, personalOwner: retained.personalOwner.identity })
        )
            return undefined;
        const source = version.source;
        if (source?.kind === "individual") {
            if (
                source.review?.originalAttrs?.planId !== version.planId ||
                source.review.planRevision !== version.revision ||
                source.review.reviewEvidence?.planId !== version.planId ||
                source.review.reviewEvidence.runwieldSessionId !== runwieldSessionId
            )
                return undefined;
        } else if (
            source?.kind !== "sequence" ||
            source.documents?.[0]?.planId !== version.planId ||
            source.documents[0].revision !== version.revision
        ) {
            return undefined;
        }
        return this.retain(version);
    }

    matching(
        reference: PlanReviewVersion,
        projectId: ProjectId,
        planId: PlanId,
        boundOwner: ReviewSourceOwner | undefined,
        sourceOwner: ReviewSourceOwner | undefined,
    ): RetainedReviewVersion<Result> | undefined {
        const retained = this.#versions.get(reference);
        if (!retained) return undefined;
        const { version } = retained;
        if (
            version.owner.projectId !== projectId ||
            version.planId !== planId ||
            !sameReviewOwner(version.owner, boundOwner) ||
            !sameReviewOwner(version.owner, sourceOwner)
        )
            return undefined;
        return retained;
    }

    checkout(reference: PlanReviewVersion): string | undefined {
        return this.#versions.get(reference)?.version.cwd;
    }

    operation(reference: PlanReviewVersion) {
        const version = this.#versions.get(reference)?.version;
        return version && { operationId: version.operationId, planId: version.planId };
    }
}
