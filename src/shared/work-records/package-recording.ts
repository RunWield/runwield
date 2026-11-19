import { requireProjectCheckout } from "../project-identity.ts";
/** Durable Recorder acceptance and canonical settlement for one admitted delivery attempt. */
import fs from "node:fs/promises";
import { basename, join } from "node:path";
import { writeJsonAtomically } from "../private-json-file.ts";
import { workRecordOwnerLayout, assertWorkRecordPath, withWorkRecordMutation } from "./owner.ts";
import { findWorkRecordById, replaceWorkRecord } from "./store.ts";
import {
    generateRecorderSections,
    generateWorkRecordForSource,
    normalizeRecorderOutput,
    validateRecorderProposals,
} from "./generation.ts";
import { formatWorkRecordMarkdown, parseWorkRecordMarkdown } from "./markdown.ts";
import { approveWorkRecord } from "./lifecycle.ts";
import { applyWorkRecordSupersession } from "./supersession.ts";
import { syncWorkRecordToIndex } from "./index-adapter.ts";
import { retainWorkRecordLocation, workRecordDigest } from "./import.ts";
import type { DeliveryCopy, PackagePublicationManifest } from "../../plan-store/index.ts";
import type { WorkRecordMnemotecaPort } from "./mnemoteca-port.ts";

type Source = import("./generation.ts").WorkRecordSource;
type Options = import("./generation.ts").WorkRecordGenerationOptions;
type Sections = import("./generation.ts").GeneratedWorkRecordSections;
export interface RecordingPreparation {
    version: 1;
    attemptId: string;
    recordId: string;
    createdAt: string;
    sections?: Sections;
    record?: DeliveryCopy;
    settled?: boolean;
}
function preparationPath(attemptId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(attemptId)) throw new Error("Invalid recording attempt identity.");
    const owner = workRecordOwnerLayout();
    if (!owner) throw new Error("Recording requires admitted personal ownership.");
    const path = join(owner.internal, "preparations", `${attemptId}.json`);
    assertWorkRecordPath(path);
    return path;
}
export async function readPreparedPackageRecord(attemptId: string): Promise<RecordingPreparation | null> {
    const text = await fs.readFile(preparationPath(attemptId), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
    });
    if (text === null) return null;
    if (!text.trim()) throw new Error("Recording preparation is empty.");
    const state: RecordingPreparation = JSON.parse(text);
    if (
        state.version !== 1 ||
        state.attemptId !== attemptId ||
        typeof state.recordId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(state.recordId) ||
        (state.settled !== undefined && typeof state.settled !== "boolean")
    )
        throw new Error("Recording preparation identity changed.");
    if (state.sections !== undefined) normalizeRecorderOutput(state.sections);
    return state;
}
export async function inspectPreparedPackageRecord(attemptId: string) {
    const state = await readPreparedPackageRecord(attemptId);
    return state
        ? { recordId: state.recordId, accepted: Boolean(state.sections), retained: Boolean(state.record) }
        : null;
}

export async function preparedPackageRecordCopy(attemptId: string): Promise<DeliveryCopy | undefined> {
    return (await readPreparedPackageRecord(attemptId))?.record;
}

export async function reservePreparedPackageRecord(attemptId: string): Promise<RecordingPreparation> {
    return await withWorkRecordMutation(async () => {
        const retained = await readPreparedPackageRecord(attemptId);
        if (retained) return retained;
        const state: RecordingPreparation = {
            version: 1,
            attemptId,
            recordId: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
        };
        writeJsonAtomically(preparationPath(attemptId), state);
        return state;
    });
}

/** Acceptance is retained before canonical persistence; retries keep the identity, date and sections. */
export async function generatePreparedPackageRecord(cwd: string, source: Source, attemptId: string, options: Options) {
    const prepared = await reservePreparedPackageRecord(attemptId);
    const result = await generateWorkRecordForSource(
        cwd,
        { ...source, preparedRecordId: prepared.recordId },
        {
            ...options,
            now: () => new Date(prepared.createdAt),
            idGenerator: () => prepared.recordId,
            runRecorderStep: async (prompt: string) => {
                if (prepared.sections) return normalizeRecorderOutput(prepared.sections);
                const request: { settledSupersedes: string[] } = JSON.parse(prompt);
                const sections = await generateRecorderSections(
                    cwd,
                    source,
                    options,
                    prepared.recordId,
                    request.settledSupersedes,
                );
                await validateRecorderProposals(
                    cwd,
                    prepared.recordId,
                    (sections.supersessionProposals || []).filter(
                        (candidate) => !request.settledSupersedes.includes(candidate.recordId),
                    ),
                );
                prepared.sections = sections;
                writeJsonAtomically(preparationPath(attemptId), prepared);
                return sections;
            },
        },
    );
    if (result.status === "generated" || result.status === "linked") {
        const record = await findWorkRecordById(cwd, prepared.recordId);
        if (!record) throw new Error("Prepared canonical Work Record is missing.");
        if (!prepared.record) {
            prepared.record = {
                kind: "work-record",
                path: `docs/work-records/${basename(record.path)}`,
                text: record.markdown,
            };
            writeJsonAtomically(preparationPath(attemptId), prepared);
        }
    }
    return result;
}

/** Invoked after a matching durable delivery receipt; no Git mutation is part of record settlement. */
export type PreparedRecordDelivery = Pick<
    PackagePublicationManifest,
    "attemptId" | "preparedRecord" | "copies" | "repositoryId"
>;
export async function settlePreparedPackageRecord(
    cwd: string,
    manifest: PackagePublicationManifest,
    mnemotecaPort: WorkRecordMnemotecaPort,
    executionRepositoryRoot?: string,
): Promise<string | undefined> {
    return await settlePreparedRecord(cwd, manifest, mnemotecaPort, executionRepositoryRoot);
}
export async function settlePreparedRecord(
    cwd: string,
    manifest: PreparedRecordDelivery,
    mnemotecaPort: WorkRecordMnemotecaPort,
    executionRepositoryRoot?: string,
): Promise<string | undefined> {
    const copy = manifest.preparedRecord;
    if (!copy) return undefined;
    const frozen = parseWorkRecordMarkdown(copy.text, { path: copy.path, relativePath: copy.path });
    let record = await findWorkRecordById(cwd, frozen.attrs.recordId);
    if (!record) throw new Error("Prepared canonical Work Record is missing; delivery remains confirmed.");
    const preparation = await readPreparedPackageRecord(manifest.attemptId);
    if (!preparation || preparation.recordId !== frozen.attrs.recordId || preparation.record?.text !== copy.text)
        throw new Error("Retained recording preparation does not match delivery.");
    if (!preparation.settled) {
        await withWorkRecordMutation(async () => {
            const owner = workRecordOwnerLayout()!;
            if (
                manifest.copies.some(
                    (item) => item.kind === "work-record" && item.path === copy.path && item.text === copy.text,
                )
            )
                await retainWorkRecordLocation(frozen.attrs.recordId, {
                    kind: "copy",
                    sourcePath: join(
                        executionRepositoryRoot ?? requireProjectCheckout(owner.identity).checkoutRoot,
                        copy.path,
                    ),
                    repositoryId: manifest.repositoryId,
                    repositoryPath: copy.path,
                    digest: workRecordDigest(copy.text),
                });
        });
        const indexWarning = await withWorkRecordMutation(async () => {
            const current = await findWorkRecordById(cwd, frozen.attrs.recordId);
            if (!current) throw new Error("Prepared canonical Work Record is missing.");
            record = current;
            // Replay never restores a later archive/supersession or replaces editor prose.
            if (
                (current.attrs.status !== "approved" && current.attrs.status !== "pending_verification") ||
                current.attrs.archivedAt ||
                current.attrs.supersededBy ||
                current.body !== frozen.body ||
                (current.attrs.status === "pending_verification" && current.markdown !== copy.text)
            )
                return undefined;
            const declared = frozen.attrs.supersedes;
            const predecessors: string[] = [];
            for (const id of Array.isArray(declared) ? declared : declared ? [declared] : []) {
                const predecessor = await findWorkRecordById(cwd, id);
                // A later explicit relationship or deletion wins over an older settlement replay.
                if (
                    predecessor &&
                    (!predecessor.attrs.supersededBy || predecessor.attrs.supersededBy === frozen.attrs.recordId)
                )
                    predecessors.push(id);
            }
            if (predecessors.length) {
                const result = await applyWorkRecordSupersession(cwd, {
                    successorRecordId: frozen.attrs.recordId,
                    predecessorRecordIds: predecessors,
                    mnemotecaPort,
                });
                if (result.indexWarning) return result.indexWarning;
            }
            const settled = await findWorkRecordById(cwd, frozen.attrs.recordId);
            if (!settled) throw new Error("Prepared canonical Work Record is missing.");
            // Approval makes the record current, so locations and all declared relationships must precede it.
            record =
                settled.attrs.status === "pending_verification" && settled.markdown === copy.text
                    ? await replaceWorkRecord(
                          cwd,
                          settled,
                          formatWorkRecordMarkdown(approveWorkRecord(settled.attrs), settled.body),
                      )
                    : settled;
            return undefined;
        });
        if (indexWarning) return indexWarning;
        preparation.settled = true;
        writeJsonAtomically(preparationPath(manifest.attemptId), preparation);
    }
    try {
        await syncWorkRecordToIndex(cwd, record, { mnemotecaPort });
    } catch (error) {
        return `Delivery is confirmed. Work Record index synchronization can retry: ${error instanceof Error ? error.message : String(error)}`;
    }
    return undefined;
}

/** An accepted preparation can outlive the selected package or the execution checkout. */
export async function unfinishedRecordingPins() {
    const records = new Set<string>();
    const plans = new Set<string>();
    const attempts = new Set<string>();
    const owner = workRecordOwnerLayout();
    if (!owner) return { records, plans, attempts };
    const dir = join(owner.internal, "preparations");
    assertWorkRecordPath(dir);
    const files = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    for (const file of files.filter((name) => name.endsWith(".json"))) {
        const state = await readPreparedPackageRecord(file.slice(0, -5));
        if (!state) throw new Error("Cannot verify Recorder pins for a missing preparation.");
        if (state.settled) continue;
        attempts.add(state.attemptId);
        records.add(state.recordId.toLowerCase());
        for (const proposal of state.sections?.supersessionProposals || [])
            records.add(proposal.recordId.toLowerCase());
        if (state.record) {
            const { attrs } = parseWorkRecordMarkdown(state.record.text);
            for (const id of attrs.provenance?.sourcePlans || []) plans.add(id);
            for (const id of [attrs.supersedes || []].flat()) records.add(id.toLowerCase());
        }
    }
    return { records, plans, attempts };
}
