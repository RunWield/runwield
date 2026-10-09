/** Local immutable check receipts. Reporting failures never change delivery authority. */
import type { PublicationAttempt } from "./publication-attempt.ts";
import { join, relative } from "@std/path";
import { resolveProjectRuntimeLayout } from "../project-runtime-layout.ts";
import type { DeliveryReportArtifact } from "./delivery-report.ts";

export type DeliveryEvidenceKind = "ci" | "ai" | "ai-skip" | "human" | "ci-repair" | "ai-repair" | "human-revision";
export interface DeliveryEvidenceEntry {
    version: 1;
    kind: DeliveryEvidenceKind;
    outcome: string;
    recordedAt: string;
    detail: string;
}
export interface DeliveryEvidenceSummary {
    entries: DeliveryEvidenceEntry[];
    artifacts: DeliveryReportArtifact[];
}
function directory(root: string, plan: string, attempt: string): string {
    return join(
        resolveProjectRuntimeLayout(root).primary.deliveryEvidenceRoot,
        encodeURIComponent(plan),
        encodeURIComponent(attempt),
    );
}
export async function recordDeliveryEvidence(
    root: string,
    plan: string,
    attempt: string,
    kind: DeliveryEvidenceKind,
    outcome: string,
    detail = "",
): Promise<void> {
    try {
        const dir = directory(root, plan, attempt);
        await Deno.mkdir(dir, { recursive: true });
        const entry: DeliveryEvidenceEntry = {
            version: 1,
            kind,
            outcome,
            recordedAt: new Date().toISOString(),
            detail,
        };
        await Deno.writeTextFile(join(dir, `${crypto.randomUUID()}.json`), JSON.stringify(entry), { createNew: true });
    } catch {
        // Missing receipts remain explicitly unavailable rather than blocking publication.
    }
}
export async function readDeliveryEvidence(
    root: string,
    plan: string,
    attempt: string,
): Promise<DeliveryEvidenceSummary> {
    const entries: DeliveryEvidenceEntry[] = [];
    const artifacts: DeliveryReportArtifact[] = [];
    const dir = directory(root, plan, attempt);
    try {
        for await (const file of Deno.readDir(dir)) {
            if (!file.isFile || !file.name.endsWith(".json")) continue;
            try {
                const entry: DeliveryEvidenceEntry = JSON.parse(await Deno.readTextFile(join(dir, file.name)));
                if (
                    entry.version === 1 && typeof entry.kind === "string" && typeof entry.detail === "string" &&
                    typeof entry.outcome === "string" && typeof entry.recordedAt === "string"
                ) entries.push(entry);
            } catch { /* An incomplete receipt cannot count as evidence. */ }
        }
        entries.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
        const groups = [["ci", "Test results"], ["ai", "Reviewer findings"], ["human", "Human decisions"]] as const;
        for (const [kind, title] of groups) {
            const checks = entries.filter((entry) => entry.kind === kind);
            if (!checks.length) continue;
            const path = relative(root, join(dir, `${kind}.md`)).replaceAll("\\", "/");
            const markdown = [
                `# ${title}`,
                "",
                `Plan: ${plan}`,
                "",
                "Recorded checks only; older or unavailable history is not reconstructed.",
                "",
                ...checks.flatMap((
                    entry,
                    i,
                ) => [`## ${i + 1}. ${entry.outcome}`, "", `Recorded: ${entry.recordedAt}`, "", entry.detail, ""]),
            ].join("\n");
            await Deno.writeTextFile(join(root, path), markdown);
            artifacts.push({ title, kind: "report", path });
        }
    } catch { /* Readable receipts still survive a missing report export. */ }
    return { entries, artifacts };
}

/** A readable publication receipt links exact commits without guessing a forge URL. */
export async function savePublicationEvidence(
    root: string,
    publication: PublicationAttempt,
): Promise<DeliveryReportArtifact | null> {
    if (!publication.verifiedAt || !publication.publishedCommit) return null;
    const path = relative(root, join(directory(root, publication.planName, publication.attemptId), "publication.md"))
        .replaceAll("\\", "/");
    try {
        await Deno.mkdir(directory(root, publication.planName, publication.attemptId), { recursive: true });
        await Deno.writeTextFile(
            join(root, path),
            [
                "# Merge confirmation",
                "",
                `Plan: ${publication.planName}`,
                "",
                "## Checked candidate",
                "",
                publication.validatedCommit,
                "",
                "## Delivered commit",
                "",
                publication.publishedCommit,
                "",
                `Landing branch: ${publication.targetBranch}`,
                "",
                `Publication mode: ${publication.publicationMode || "unavailable"}`,
                "",
                `Confirmed: ${publication.verifiedAt}`,
                "",
                "The candidate and delivered commit can differ after artifact commits or merge integration. This receipt does not claim CI ran on the delivered commit.",
            ].join("\n"),
        );
        return { title: "Merge confirmation", kind: "report", path };
    } catch {
        return null;
    }
}

/** Snapshot the approved Plan so the reader cannot accidentally show a stale primary document. */
export async function saveDeliveredPlanEvidence(
    root: string,
    publication: PublicationAttempt,
    markdown: string,
): Promise<DeliveryReportArtifact | null> {
    const dir = directory(root, publication.planName, publication.attemptId);
    try {
        await Deno.mkdir(dir, { recursive: true });
        const path = join(dir, "plan.md");
        await Deno.writeTextFile(path, markdown);
        return { title: "Approved Plan", kind: "plan", path: relative(root, path).replaceAll("\\", "/") };
    } catch {
        return null;
    }
}

export async function saveDeliveredWorkRecordEvidence(
    root: string,
    publication: PublicationAttempt,
    markdown: string,
): Promise<DeliveryReportArtifact | null> {
    const dir = directory(root, publication.planName, publication.attemptId);
    try {
        await Deno.mkdir(dir, { recursive: true });
        const path = join(dir, "work-record.md");
        await Deno.writeTextFile(path, markdown);
        return { title: "Work Record", kind: "work-record", path: relative(root, path).replaceAll("\\", "/") };
    } catch {
        return null;
    }
}
