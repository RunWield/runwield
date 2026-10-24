import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCwd } from "../src/constants.js";
import { runAcceptance } from "../src/attached/claude/acceptance/driver.ts";

const usage = "bun scripts/connect-claude-acceptance.ts [--claude <path>] [--out <dir>] [--keep]";

export function parseAcceptanceArgs(args: string[]) {
    let claude: string | undefined, out: string | undefined;
    let keep = false;
    for (let index = 0; index < args.length; index++) {
        const flag = args[index];
        if (flag === "--keep") keep = true;
        else if (flag === "--claude" || flag === "--out") {
            const value = args[++index];
            if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
            if (flag === "--claude") claude = value;
            else out = value;
        } else throw new Error(`Unrecognized option: ${flag}`);
    }
    return { claude, out, keep };
}

async function main(): Promise<void> {
    if (process.argv.slice(2).includes("--help")) console.log(usage);
    else {
        try {
            const options = parseAcceptanceArgs(process.argv.slice(2));
            let executable = options.claude;
            if (!executable) {
                try {
                    executable = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
                } catch {
                    executable = "claude";
                }
            }
            const root = options.out
                ? resolve(getCwd(), options.out)
                : await mkdtemp(join(tmpdir(), "runwield-claude-acceptance-"));
            const summary = await runAcceptance({
                root,
                checkout: fileURLToPath(new URL("../", import.meta.url)),
                claude: resolve(getCwd(), executable),
                keep: options.keep,
            });
            console.log(`Claude acceptance: ${summary.outcome}. Evidence: ${join(root, "summary.json")}`);
            if (summary.blockedPrerequisite) {
                console.error(
                    `Prerequisite: ${summary.blockedPrerequisite}. See logs/driver.log in the evidence directory.`,
                );
                if (summary.blockedPrerequisite === "claude-authentication")
                    console.error(
                        "The isolated host needs Claude authentication. Supply CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token) or ANTHROPIC_API_KEY, then rerun in a new evidence directory. Core receives neither credential.",
                    );
            }
            process.exitCode = summary.outcome === "pass" ? 0 : 1;
        } catch (error) {
            console.error(error instanceof Error ? error.message : "Acceptance failed");
            process.exitCode = 1;
        }
    }
}

if (import.meta.main) await main();
