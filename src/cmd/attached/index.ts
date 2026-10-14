import { getCwd } from "../../constants.js";
import { runAttachedOperation } from "../../shared/attached/coordinator.ts";
import { ATTACHED_OPERATIONS, MAX_ATTACHED_INPUT_BYTES } from "../../shared/attached/operations.ts";
import { VERSION } from "../../shared/version.js";
import process from "node:process";
/**
 * @module cmd/attached
 * `wld attached activate|triage_report|status|plan_written|start_execution|task_completed|mcp`: the CLI carrier for the Attached Workflow
 * Coordinator. Each operation reads one JSON object from stdin and prints one JSON
 * result. A rejected operation exits with code 1.
 *
 * Exits explicitly: modules loaded with the command registry reset `process.exitCode`.
 */

const USAGE =
    'Usage: wld attached <activate|triage_report|status|plan_written|start_execution|task_completed|start_validation|review_diff|review_complete|validation_decision> < input.json\n       wld attached mcp\nstatus input: {"workflowId": "..."} or {} for the latest open workflow';

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
    if (subcommand === "mcp" && rest.length === 0) {
        const { runAttachedMcpServer } = await import("../../attached/claude/mcp.ts");
        await runAttachedMcpServer(getCwd(), VERSION);
        return;
    }
    const operation = ATTACHED_OPERATIONS.find((entry) => entry.name === subcommand);
    if (!operation || rest.length > 0) {
        console.error(USAGE);
        process.exit(1);
    }
    const result = await runAttachedOperation(operation.name, getCwd(), await readBoundedStdin());
    console.log(JSON.stringify(result));
    if (!result.ok) process.exit(1);
}
