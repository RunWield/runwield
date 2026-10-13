import { getHomeDir } from "../../../../../constants.js";
import { readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import process from "node:process";

function readArg(args: string[], flag: string): string {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] || "" : "";
}
function joinPath(...parts: string[]): string {
    return parts.map((part, index) => {
        const trimmed = index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, "");
        return trimmed;
    }).filter(Boolean).join("/");
}
async function main(): Promise<void> {
    const prompt = readArg(process.argv.slice(2), "-p");
    const outputFormat = readArg(process.argv.slice(2), "--output-format");
    if (prompt === "/agents" && outputFormat === "json") {
        const agentsRoot = joinPath(getHomeDir(), ".gemini", "config", "agents");
        const agents: Array<{ name: string }> = [];
        try {
            for await (const entry of await fsReaddir(agentsRoot, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                try {
                    const definition = await fsReadFile(joinPath(agentsRoot, entry.name, "agent.md"), "utf8");
                    if (
                        definition.includes("\nname: " + entry.name + "\n") ||
                        definition.startsWith("---\nname: " + entry.name + "\n")
                    ) {
                        agents.push({ name: entry.name });
                    }
                } catch {
                    // Ignore malformed agent directories.
                }
            }
        } catch {
            // No agents directory yet.
        }
        console.log(JSON.stringify({ agents }));
        process.exit(0);
    }
    process.exit(0);
}
await main();
