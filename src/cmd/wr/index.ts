/**
 * @module cmd/wr
 * List, search, read, index, and backfill canonical Work Records.
 */

import { retryWorkRecordForPlan } from "../../shared/work-records/auto-generation.ts";
import { parseArgs } from "@std/cli/parse-args";
import { getCwd } from "../../constants.js";
import {
    confirmWorkRecordSupersessionProposal,
    formatWorkRecordBackfillOutcomes,
    formatWorkRecordBackfillPreview,
    formatWorkRecordList,
    formatWorkRecordSearchResults,
    listWorkRecords,
    listWorkRecordSupersessionProposals,
    previewWorkRecordBackfill,
    readWorkRecordById,
    rebuildWorkRecordIndex,
    rejectWorkRecordSupersessionProposal,
    runWorkRecordBackfill,
    searchWorkRecords,
    WorkRecordReadError,
} from "../../shared/work-records/index.ts";
import type { WorkRecordMnemotecaPort } from "../../shared/work-records/mnemoteca-port.ts";
import { NO_OPEN_BROWSER_PORT, SYSTEM_BROWSER_PORT } from "../../shared/browser-port.ts";
import { startArtifactReadSurface } from "../../ui/review/review-launcher.ts";
import { printCommandHelp } from "../help/index.js";
import {
    resolveWorkRecordSupersessionProposals,
    type WorkRecordSupersessionDecision,
} from "../../shared/workflow/validation-helpers.ts";
import type { WorkRecordSupersessionCandidate } from "../../shared/work-records/schema.ts";

export interface WorkRecordCommandOptions {
    uiAPI?: Pick<import("../../ui/tui/types.js").UiAPI, "appendSystemMessage" | "promptSelect">;
    mnemotecaPort: WorkRecordMnemotecaPort;
}

async function chooseSupersessionDecision(
    proposal: WorkRecordSupersessionCandidate,
    options: WorkRecordCommandOptions,
): Promise<WorkRecordSupersessionDecision | null> {
    const promptText = `Supersede ${proposal.recordId}? Reason: ${proposal.reason}`;
    if (options.uiAPI) {
        const answer = await options.uiAPI.promptSelect(promptText, [
            { value: "confirm", label: "Confirm supersession" },
            { value: "reject", label: "Reject proposal" },
            { value: "later", label: "Decide later" },
        ]);
        return ["confirm", "reject", "later"].includes(String(answer))
            ? answer as WorkRecordSupersessionDecision
            : null;
    }
    const answer = prompt(`${promptText}\nType confirm, reject, or later:`)?.trim().toLowerCase();
    return answer === "confirm" || answer === "reject" || answer === "later" ? answer : null;
}

async function resolveCommandProposals(
    successorRecordId: string,
    proposals: WorkRecordSupersessionCandidate[],
    options: WorkRecordCommandOptions,
): Promise<void> {
    await resolveWorkRecordSupersessionProposals({
        projectRoot: getCwd(),
        successorRecordId,
        proposals,
        mnemotecaPort: options.mnemotecaPort,
        choose: (proposal) => chooseSupersessionDecision(proposal, options),
        notify: (message) => console.log(`[RunWield] ${message}`),
    });
}

function promptForBackfillConfirmation(message: string): boolean {
    const answer = prompt(`${message}\nType BACKFILL to continue:`) || "";
    return answer.trim() === "BACKFILL";
}

async function openWorkRecordReadSurface(
    record: Awaited<ReturnType<typeof readWorkRecordById>>,
    options: { noOpen?: boolean } = {},
): Promise<void> {
    const noOpen = options.noOpen === true;
    const server = await startArtifactReadSurface({
        cwd: getCwd(),
        markdown: record.markdown,
        artifactKind: "work-record",
        title: record.title,
        path: record.path,
        notices: record.notices,
        browser: noOpen ? NO_OPEN_BROWSER_PORT : SYSTEM_BROWSER_PORT,
    });
    console.log(`[RunWield] Work Record read-only view: ${server.url}`);
    if (!server.opened && !noOpen) {
        console.log(
            "[RunWield] Could not open your browser automatically. Open the URL above, then choose Close when finished.",
        );
    }
    try {
        await server.waitForDecision();
    } finally {
        await stopReadSurface(server);
    }
}

async function stopReadSurface(
    server: Pick<Awaited<ReturnType<typeof startArtifactReadSurface>>, "stop">,
): Promise<void> {
    await Promise.race([
        Promise.resolve(server.stop()),
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
}

function rejectUnknownFlags(
    parsed: ReturnType<typeof parseArgs>,
    allowedFlags: string[] = [],
): void {
    const allowed = new Set(["_", "help", "h", ...allowedFlags]);
    for (const key of Object.keys(parsed)) {
        if (!allowed.has(key)) throw new Error(`Unsupported flag: --${key}`);
    }
}

function formatRebuildResult(result: Awaited<ReturnType<typeof rebuildWorkRecordIndex>>): string {
    const lines = [
        `[RunWield] Rebuilt Work Record index: ${result.collection}`,
        `  canonical records: ${result.total}`,
        `  indexed: ${result.added}`,
        `  failed: ${result.failed}`,
    ];
    for (const failure of result.failures || []) {
        lines.push(`  WARNING: ${failure.recordId} (${failure.path}): ${failure.error}`);
    }
    return lines.join("\n");
}

export async function runWorkRecordsCommand(
    argv: string[],
    options: WorkRecordCommandOptions,
): Promise<void> {
    const mnemotecaPort = options.mnemotecaPort;
    const subcommand = argv[0] && !argv[0].startsWith("-") ? argv[0] : "list";
    const rest = subcommand === "list" ? (argv[0] === "list" ? argv.slice(1) : argv) : argv.slice(1);

    if (subcommand === "help") {
        printCommandHelp("wr");
        return;
    }

    if (subcommand === "retry") {
        if (rest.length !== 1 || rest[0].startsWith("-")) throw new Error("Usage: wld wr retry <plan-name>");
        const result = await retryWorkRecordForPlan({ cwd: getCwd(), planName: rest[0], mnemotecaPort });
        console.log(result.message);
        if (result.recordId && result.supersessionProposals?.length) {
            await resolveCommandProposals(result.recordId, result.supersessionProposals, options);
        }
        return;
    }

    if (subcommand === "backfill") {
        const parsed = parseArgs(rest, {
            boolean: ["help", "yes", "dry-run"],
            alias: { h: "help", y: "yes" },
        });
        if (parsed.help) {
            printCommandHelp("wr");
            return;
        }
        rejectUnknownFlags(parsed, ["yes", "y", "dry-run"]);
        if (parsed.yes && parsed["dry-run"]) throw new Error("Cannot combine --yes with --dry-run.");
        let backfillFinished = false;
        try {
            const preview = await previewWorkRecordBackfill(getCwd());
            console.log(formatWorkRecordBackfillPreview(preview));
            if (parsed["dry-run"]) {
                console.log("[RunWield] Dry run only; no Work Records or Plan backlinks were written.");
                return;
            }
            if (!preview.eligible.length) return;
            const confirmed = parsed.yes || promptForBackfillConfirmation(
                `[RunWield] Backfill will process ${preview.eligible.length} eligible source(s).`,
            );
            if (!confirmed) {
                console.log("[RunWield] Backfill canceled; no Work Records or Plan backlinks were written.");
                return;
            }
            const result = await runWorkRecordBackfill(getCwd(), { mnemotecaPort });
            backfillFinished = true;
            console.log(formatWorkRecordBackfillOutcomes(result.outcomes));
            for (const outcome of result.outcomes) {
                if (
                    (outcome.status === "generated" || outcome.status === "linked") && outcome.recordId &&
                    outcome.supersessionProposals?.length
                ) {
                    await resolveCommandProposals(outcome.recordId, outcome.supersessionProposals, options);
                }
            }
            return;
        } catch (error) {
            if (!(error instanceof WorkRecordReadError)) throw error;
            console.log(
                `[RunWield] Backfill stopped at ${error.filePath}. ${error.reason} ${
                    backfillFinished ? "Saved records were kept." : "No files were changed."
                } Fix this record, then run wld wr backfill again.`,
            );
            return;
        }
    }

    if (subcommand === "supersede") {
        const parsed = parseArgs(rest, {
            boolean: ["help"],
            string: ["confirm", "reject"],
            alias: { h: "help" },
        });
        if (parsed.help) {
            printCommandHelp("wr");
            return;
        }
        rejectUnknownFlags(parsed, ["confirm", "reject"]);
        const confirmCount = rest.filter((arg) => arg === "--confirm" || arg.startsWith("--confirm=")).length;
        const rejectCount = rest.filter((arg) => arg === "--reject" || arg.startsWith("--reject=")).length;
        if (confirmCount > 1 || rejectCount > 1) {
            throw new Error("--confirm and --reject each accept exactly one predecessorRecordId.");
        }
        if (parsed.confirm && parsed.reject) throw new Error("Cannot combine --confirm with --reject.");
        if (parsed._.length > 1) {
            throw new Error(
                "Usage: wld wr supersede [successorRecordId] [--confirm predecessorRecordId | --reject predecessorRecordId]",
            );
        }
        const proposals = await listWorkRecordSupersessionProposals(getCwd());
        const successorRecordId = parsed._.length === 1 ? String(parsed._[0]) : "";
        if (!successorRecordId) {
            if (parsed.confirm || parsed.reject) {
                throw new Error("A successorRecordId is required with --confirm or --reject.");
            }
            if (!proposals.length) {
                console.log("[RunWield] No pending Work Record supersession proposals.");
                return;
            }
            console.log("[RunWield] Pending Work Record supersession proposals:");
            for (const proposal of proposals) {
                console.log(
                    `  ${proposal.successorRecordId} may supersede ${proposal.predecessorRecordId}: ${proposal.reason}`,
                );
            }
            return;
        }
        const candidates = proposals.filter((proposal) =>
            proposal.successorRecordId.toLowerCase() === successorRecordId.toLowerCase()
        );
        if (parsed.confirm || parsed.reject) {
            const predecessorRecordId = String(parsed.confirm || parsed.reject);
            const proposal = candidates.find((item) =>
                item.predecessorRecordId.toLowerCase() === predecessorRecordId.toLowerCase()
            );
            if (!proposal) {
                throw new Error(
                    `Supersession proposal is not pending: ${predecessorRecordId} -> ${successorRecordId}.`,
                );
            }
            const decision = parsed.confirm ? "confirm" : "reject";
            const canonicalSuccessorRecordId = proposal.successorRecordId;
            const canonicalPredecessorRecordId = proposal.predecessorRecordId;
            const result = decision === "confirm"
                ? await confirmWorkRecordSupersessionProposal(getCwd(), {
                    successorRecordId: canonicalSuccessorRecordId,
                    predecessorRecordId: canonicalPredecessorRecordId,
                    mnemotecaPort,
                })
                : await rejectWorkRecordSupersessionProposal(getCwd(), {
                    successorRecordId: canonicalSuccessorRecordId,
                    predecessorRecordId: canonicalPredecessorRecordId,
                    mnemotecaPort,
                });
            console.log(
                `[RunWield] ${
                    decision === "confirm" ? "Confirmed" : "Rejected"
                } Work Record supersession proposal: ${canonicalPredecessorRecordId} -> ${canonicalSuccessorRecordId}.`,
            );
            if (result.indexWarning) console.log(`[RunWield] Warning: ${result.indexWarning}`);
            return;
        }
        if (!candidates.length) {
            console.log(`[RunWield] No pending supersession proposals for ${successorRecordId}.`);
            return;
        }
        await resolveCommandProposals(
            candidates[0].successorRecordId,
            candidates.map((proposal) => ({ recordId: proposal.predecessorRecordId, reason: proposal.reason })),
            options,
        );
        return;
    }

    if (subcommand === "search") {
        const parsed = parseArgs(rest, { boolean: ["help", "all"], alias: { h: "help" } });
        if (parsed.help) {
            printCommandHelp("wr");
            return;
        }
        rejectUnknownFlags(parsed, ["all"]);
        const query = parsed._.map(String).join(" ").trim();
        if (!query) throw new Error("Usage: wld wr search <query> [--all]");
        console.log(
            formatWorkRecordSearchResults(
                await searchWorkRecords(getCwd(), query, { includeAll: Boolean(parsed.all), mnemotecaPort }),
            ),
        );
        return;
    }

    if (subcommand === "read") {
        const parsed = parseArgs(rest, { boolean: ["help", "no-open"], alias: { h: "help" } });
        if (parsed.help) {
            printCommandHelp("wr");
            return;
        }
        rejectUnknownFlags(parsed, ["no-open"]);
        if (parsed._.length !== 1) throw new Error("Usage: wld wr read <recordId> [--no-open]");
        await openWorkRecordReadSurface(
            await readWorkRecordById(getCwd(), String(parsed._[0]), { accessMode: "all" }),
            { noOpen: Boolean(parsed["no-open"]) },
        );
        return;
    }

    if (subcommand === "index") {
        const action = rest[0] || "";
        if (action !== "rebuild") throw new Error("Usage: wld wr index rebuild");
        const parsed = parseArgs(rest.slice(1), { boolean: ["help"], alias: { h: "help" } });
        if (parsed.help) {
            printCommandHelp("wr");
            return;
        }
        rejectUnknownFlags(parsed);
        if (parsed._.length) throw new Error("Usage: wld wr index rebuild");
        console.log(formatRebuildResult(await rebuildWorkRecordIndex(getCwd(), { mnemotecaPort })));
        return;
    }

    if (subcommand !== "list") throw new Error(`Unknown Work Records command: ${subcommand}. Try wld wr --help.`);

    const parsed = parseArgs(rest, { boolean: ["help", "all"], alias: { h: "help" } });
    if (parsed.help) {
        printCommandHelp("wr");
        return;
    }
    rejectUnknownFlags(parsed, ["all"]);
    if (parsed._.length) throw new Error("Usage: wld wr list [--all]");
    console.log(formatWorkRecordList(await listWorkRecords(getCwd()), { includeAll: Boolean(parsed.all) }));
}
