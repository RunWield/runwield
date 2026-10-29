import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCwd } from "../src/constants.js";
import { runAcceptance } from "../src/attached/codex/acceptance/driver.ts";
import { runLiveAcceptance } from "../src/attached/codex/acceptance/live.ts";

export function parseCodexAcceptanceArgs(args: string[]) {
    let codex = "codex",
        out: string | undefined;
    let keep = false,
        live = false;
    for (let index = 0; index < args.length; index++) {
        const flag = args[index];
        if (flag === "--keep") keep = true;
        else if (flag === "--live") live = true;
        else if (flag === "--codex" || flag === "--out") {
            const value = args[++index];
            if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
            if (flag === "--codex") codex = value;
            else out = value;
        } else throw new Error(`Unrecognized option: ${flag}`);
    }
    return { codex, out, keep, live };
}
async function main(): Promise<void> {
    if (process.argv.includes("--help"))
        console.log(
            "bun scripts/connect-codex-acceptance.ts [--codex <path>] [--out <new-dir>] [--keep] [--live]\nChecks an isolated installed plugin through native Codex app-server. Default does not claim live skill or desktop UI acceptance. --live spends host model tokens using existing auth in ephemeral app-server threads and explicit packaged skill/MCP configuration.",
        );
    else
        try {
            const options = parseCodexAcceptanceArgs(process.argv.slice(2));
            const root = options.out
                ? resolve(getCwd(), options.out)
                : await mkdtemp(join(tmpdir(), "runwield-codex-acceptance-"));
            const result = await (options.live ? runLiveAcceptance : runAcceptance)({
                ...options,
                root,
                checkout: fileURLToPath(new URL("../", import.meta.url)),
            });
            console.log(`Codex ${result.scope} acceptance: ${result.outcome}. Evidence: ${join(root, "summary.json")}`);
            if (result.blockedPrerequisite) console.error(`Missing prerequisite: ${result.blockedPrerequisite}`);
            process.exitCode = result.outcome === "pass" ? 0 : 1;
        } catch (error) {
            console.error(error instanceof Error ? error.message : "Acceptance failed");
            process.exitCode = 1;
        }
}

if (import.meta.main) await main();
