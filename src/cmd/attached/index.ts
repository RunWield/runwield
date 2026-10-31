import { getCwd } from "../../constants.js";
import { compactResult, compactStatus } from "../../shared/attached/presentation.ts";
import { runAttachedOperation } from "../../shared/attached/coordinator.ts";
import { ATTACHED_OPERATIONS, MAX_ATTACHED_INPUT_BYTES } from "../../shared/attached/operations.ts";
import { VERSION } from "../../shared/version.js";
import process from "node:process";
import type { AttachedAdapterManifest } from "../../attached/mcp.ts";
/**
 * @module cmd/attached
 * `wld attached` supports activate, triage_report, status, plan_written,
 * start_execution, task_completed, start_validation, review_diff, review_complete,
 * review_reply, validation_decision, work_record_completed, get_instructions,
 * get_artifact, get_pending_chat, and mcp. It is the CLI carrier for the Attached
 * Workflow Coordinator. Each operation reads one JSON object from stdin and prints one JSON
 * result. A rejected operation exits with code 1.
 *
 * Exits explicitly: modules loaded with the command registry reset `process.exitCode`.
 */

const USAGE = `Usage: wld attached <${ATTACHED_OPERATIONS.map(({ name }) => name).join("|")}> < input.json\n       wld attached mcp\n       wld attached mcp codex [--adapter-version <version> --adapter-contract <number>]\nstatus input: {"workflowId": "..."} or {} for the latest open workflow`;

type AttachedMcpLaunch = { host: "claude-code" } | { host: "codex"; adapter?: AttachedAdapterManifest };

/** Package startup metadata is bounded and complete before the MCP server starts. */
export function parseAttachedMcpArgs(args: string[]): AttachedMcpLaunch | null {
    if (args.length === 0) return { host: "claude-code" };
    if (args[0] !== "codex") return null;
    if (args.length === 1) return { host: "codex" };
    if (args.length !== 5) return null;
    let version: string | undefined;
    let adapterContract: number | undefined;
    for (let index = 1; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (
            flag === "--adapter-version" &&
            version === undefined &&
            /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(value)
        ) {
            version = value;
        } else if (
            flag === "--adapter-contract" &&
            adapterContract === undefined &&
            /^\d+$/.test(value) &&
            Number.isSafeInteger(Number(value))
        ) {
            adapterContract = Number(value);
        } else return null;
    }
    return version !== undefined && adapterContract !== undefined
        ? { host: "codex", adapter: { version, adapterContract } }
        : null;
}

/** Read stdin, stopping one byte past the limit so oversized input is still rejected as too large. */
async function readBoundedStdin(): Promise<string> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
        size += chunk.length;
        if (size > MAX_ATTACHED_INPUT_BYTES) break;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
}

export async function runAttachedCommand(argv: string[]): Promise<void> {
    const [subcommand, ...rest] = argv;
    if (subcommand === "mcp") {
        const launch = parseAttachedMcpArgs(rest);
        if (!launch) {
            console.error(USAGE);
            process.exit(1);
        }
        if (launch.host === "codex") {
            const { runAttachedMcpServer } = await import("../../attached/codex/mcp.ts");
            await runAttachedMcpServer(getCwd(), VERSION, launch.adapter);
        } else {
            const { runAttachedMcpServer } = await import("../../attached/claude/mcp.ts");
            await runAttachedMcpServer(getCwd(), VERSION);
        }
        process.exit(0);
    }
    const operation = ATTACHED_OPERATIONS.find((entry) => entry.name === subcommand);
    if (!operation || rest.length > 0) {
        console.error(USAGE);
        process.exit(1);
    }
    const result = await runAttachedOperation(operation.name, getCwd(), await readBoundedStdin());
    console.log(JSON.stringify(operation.name === "status" ? compactStatus(result, null) : compactResult(result)));
    if (!result.ok) process.exit(1);
}
