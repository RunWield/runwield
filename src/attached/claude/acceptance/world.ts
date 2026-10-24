import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, readdir, lstat, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve, delimiter } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { captureSnapshot } from "./collector.ts";
import { captureCoreSource, type CoreSource } from "./source.ts";
import { createHash } from "node:crypto";
import { ClaudeHost } from "./host.ts";
import { jsonMap, type JsonMap, type Phase, type Snapshot } from "./evidence.ts";

const VERIFICATION_COMMAND = "sh ./check.sh";
const CHECK = `#!/bin/sh
set -eu
trap 'printf "%s\\n" "$$" >> "$ACCEPTANCE_MARKER_DIR/ci-finished"' EXIT
printf '%s\\n' "$$" >> "$ACCEPTANCE_MARKER_DIR/ci-runs"
sleep 20
test "$(sh ./greet.sh Ada)" = 'Hello, Ada!'
test "$(sh ./greet.sh 'Ada Lovelace')" = 'Hello, Ada Lovelace!'
if sh ./greet.sh > /dev/null 2> missing-name.stderr; then exit 1; fi
grep -qi usage missing-name.stderr
`;

export class PrerequisiteError extends Error {
    constructor(readonly prerequisite: string) {
        super(`Acceptance prerequisite unavailable: ${prerequisite}`);
    }
}

/** Owns only a new, private evidence directory. Core writes are made by real host tools, not this module. */
export class AcceptanceWorld {
    readonly fixture: string;
    readonly sentinels = [
        "ordinary-before",
        "ordinary-attached",
        "ordinary-disabled",
        "ordinary-uninstalled",
        "ordinary-after",
    ].map((name) => `${name}-${randomUUID()}`);
    readonly issues: string[] = [];
    private source: CoreSource | null = null;
    private proxy: Server;
    private claudeEnv: NodeJS.ProcessEnv;
    private coreEnv: NodeJS.ProcessEnv;
    private constructor(
        readonly root: string,
        readonly checkout: string,
        readonly claude: string,
    ) {
        this.fixture = join(root, "fixture");
        this.claudeEnv = {
            ...process.env,
            HOME: join(root, "claude-home"),
            USERPROFILE: join(root, "claude-home"),
            CLAUDE_CONFIG_DIR: join(root, "claude-config"),
            MCP_TOOL_TIMEOUT: "600000",
            PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
        };
        // No provider credentials, inherited Core configuration, test roots, or model presets cross this boundary.
        this.coreEnv = {
            HOME: join(root, "runwield-home"),
            USERPROFILE: join(root, "runwield-home"),
            PATH: `${join(root, "sentinels")}${delimiter}${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
            TMPDIR: join(root, "tmp"),
            XDG_CACHE_HOME: join(root, "runwield-home/.cache"),
            LANG: "en_US.UTF-8",
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
            ACCEPTANCE_MARKER_DIR: join(root, "markers"),
        };
        this.proxy = createServer((request, response) => {
            try {
                const host = new URL(request.url ?? "", `http://${request.headers.host ?? ""}`).hostname;
                if (!host) throw new Error("No host");
                appendFileSync(join(root, "proxy-sink.log"), host + "\n");
            } catch {
                this.issues.push("proxy: could not identify request host");
            }
            response.writeHead(502);
            response.end();
        });
        this.proxy.on("connect", (request, socket) => {
            try {
                const host = new URL(`https://${request.url}`).hostname;
                if (!host) throw new Error("No host");
                appendFileSync(join(root, "proxy-sink.log"), host + "\n");
            } catch {
                this.issues.push("proxy: could not identify CONNECT host");
            }
            socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        });
    }

    static async create(root: string, checkout: string, claude: string): Promise<AcceptanceWorld> {
        root = resolve(root);
        try {
            const stat = await lstat(root);
            if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(root)).length)
                throw new Error("Evidence directory must be new or empty");
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        await mkdir(root, { recursive: true, mode: 0o700 });
        const world = new AcceptanceWorld(root, resolve(checkout), claude);
        try {
            await world.initialize();
            return world;
        } catch (error) {
            await world.close();
            throw error;
        }
    }
    private async initialize(): Promise<void> {
        for (const directory of [
            "fixture",
            "runwield-home/.wld/agents/shared-practice",
            "claude-home",
            "claude-config",
            "tmp",
            "bin",
            "sentinels",
            "logs/claude",
            "snapshots",
            "markers",
        ])
            await mkdir(join(this.root, directory), { recursive: true, mode: 0o700 });
        for (const file of [
            "markers/ci-runs",
            "markers/ci-finished",
            "shim-argv.jsonl",
            "sentinel-binaries.log",
            "proxy-sink.log",
            "logs/http.jsonl",
            "logs/plugins.jsonl",
            "logs/processes.jsonl",
        ])
            await writeFile(join(this.root, file), "", { flag: "wx", mode: 0o600 });
        await new Promise<void>((resolve, reject) => {
            this.proxy.once("error", reject);
            this.proxy.listen(0, "127.0.0.1", resolve);
        });
        const address = this.proxy.address();
        if (!address || typeof address === "string") throw new Error("No proxy address");
        const proxy = `http://127.0.0.1:${address.port}`;
        Object.assign(this.coreEnv, {
            HTTP_PROXY: proxy,
            HTTPS_PROXY: proxy,
            ALL_PROXY: proxy,
            http_proxy: proxy,
            https_proxy: proxy,
            all_proxy: proxy,
            NO_PROXY: "",
            no_proxy: "",
        });
        await writeFile(
            join(this.root, "runwield-home/.wld/settings.json"),
            JSON.stringify({ verification_command: VERIFICATION_COMMAND, codereview: "always", workflowMetrics: true }),
        );
        const reviewer = await readFile(
            join(this.checkout, "src/agent-definitions/shared-practice/review-practice.md"),
            "utf8",
        );
        await writeFile(
            join(this.root, "runwield-home/.wld/agents/shared-practice/review-practice.md"),
            reviewer +
                `

## Acceptance fixture rule

Read NOTES.md in the execution checkout. If it lacks the exact line \`acceptance: reviewed\`, report a blocking new finding titled \`acceptance-notes\` that requires that line. Omit id for a new finding; Core assigns its stable ledger ID. Do not edit the file. During re-review, use that Core-assigned ID and confirm the fix only after re-reading the required line.
`,
        );
        await writeFile(
            join(this.fixture, "README.md"),
            "# Greeting fixture\n\nThis repository will gain a portable shell greeting command.\n",
        );
        await writeFile(join(this.fixture, "check.sh"), CHECK, { mode: 0o755 });
        this.git(["init", "-b", "main"]);
        this.git(["config", "user.name", "Acceptance Fixture"]);
        this.git(["config", "user.email", "acceptance@example.invalid"]);
        this.git(["config", "core.excludesFile", "/dev/null"]);
        // Claude owns this file. Exclude it without adding AGENTS.md or .wld to the initial project.
        await writeFile(join(this.fixture, ".git/info/exclude"), ".claude/settings.local.json\nmissing-name.stderr\n");
        this.git(["add", "README.md", "check.sh"]);
        this.git(["commit", "-m", "Create acceptance fixture"]);
        for (const name of ["claude", "pi"])
            await writeFile(
                join(this.root, "sentinels", name),
                `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(this.root, "sentinel-binaries.log"))}, JSON.stringify({command:${JSON.stringify(name)},args:process.argv.slice(2)})+"\\n");
process.exit(1);
`,
                { mode: 0o755 },
            );
        await writeFile(
            join(this.root, "bin/wld"),
            `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(join(this.root, "shim-argv.jsonl"))},JSON.stringify(args)+"\\n");
const env=${JSON.stringify(this.coreEnv)};
// The plugin root is supplied by Claude for the installed artifact, never a bundled substitute.
if(process.env.RUNWIELD_ATTACHED_PLUGIN_ROOT) env.RUNWIELD_ATTACHED_PLUGIN_ROOT=process.env.RUNWIELD_ATTACHED_PLUGIN_ROOT;
const child=spawnSync(${JSON.stringify(process.execPath)},["--no-env-file",${JSON.stringify(join(this.checkout, "src/cli.ts"))},...args],{env,stdio:"inherit"});
process.exit(child.status ?? 1);
`,
            { mode: 0o755 },
        );
        for (const [name, stale] of [
            ["marketplace", false],
            ["stale-marketplace", true],
        ] as const) {
            const destination = join(this.root, name);
            await mkdir(join(destination, ".claude-plugin"), { recursive: true });
            await cp(
                join(this.checkout, ".claude-plugin/marketplace.json"),
                join(destination, ".claude-plugin/marketplace.json"),
            );
            const plugin = join(destination, "src/attached/claude/plugin");
            await cp(join(this.checkout, "src/attached/claude/plugin"), plugin, { recursive: true });
            if (stale) {
                await writeFile(join(plugin, "runwield-adapter.json"), JSON.stringify({ adapterContract: 0 }));
                const manifest = JSON.parse(await readFile(join(plugin, ".claude-plugin/plugin.json"), "utf8"));
                manifest.version += "-stale";
                await writeFile(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify(manifest));
            }
        }
    }
    private git(args: string[]): string {
        return execFileSync("git", args, {
            cwd: this.fixture,
            env: { ...this.coreEnv, PATH: process.env.PATH },
            encoding: "utf8",
            timeout: 30_000,
        }).trim();
    }
    plugin(phase: Phase, args: string[]): void {
        let exitCode: number | null = null;
        try {
            execFileSync(this.claude, ["plugin", ...args], {
                cwd: this.fixture,
                env: this.claudeEnv,
                timeout: 60_000,
                stdio: ["ignore", "pipe", "pipe"],
            });
            exitCode = 0;
        } finally {
            appendFileSync(
                join(this.root, "logs/plugins.jsonl"),
                JSON.stringify({ phase, args: ["plugin", ...args], exitCode }) + "\n",
            );
        }
    }
    async prepare(): Promise<JsonMap> {
        let version: string;
        try {
            version = execFileSync(this.claude, ["--version"], {
                env: this.claudeEnv,
                encoding: "utf8",
                timeout: 15_000,
            }).trim();
        } catch {
            throw new PrerequisiteError("claude-executable");
        }
        const match = /^(\d+(?:\.\d+)+) \(Claude Code\)$/.exec(version);
        if (!match) throw new PrerequisiteError("claude-version");
        try {
            const auth = JSON.parse(
                execFileSync(this.claude, ["auth", "status", "--json"], {
                    env: this.claudeEnv,
                    encoding: "utf8",
                    timeout: 30_000,
                }),
            );
            if (auth.loggedIn !== true) throw new Error("Not logged in");
        } catch {
            throw new PrerequisiteError("claude-authentication");
        }
        try {
            await readFile(join(this.checkout, "dist/workspace-bun/server/entry.mjs"));
            const assets = await readdir(join(this.checkout, "dist/workspace-bun/client/_astro"));
            if (!assets.some((name) => name.endsWith(".js"))) throw new Error("No browser assets");
        } catch {
            throw new PrerequisiteError("workspace-assets");
        }
        try {
            const env: NodeJS.ProcessEnv = { ...this.coreEnv, PATH: process.env.PATH };
            for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"])
                delete env[key];
            execFileSync("mnemoteca", ["setup"], {
                cwd: this.fixture,
                env,
                timeout: 300_000,
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch {
            throw new PrerequisiteError("mnemoteca");
        }
        const descriptor = JSON.parse(
            await readFile(join(this.root, "marketplace/src/attached/claude/plugin/runwield-adapter.json"), "utf8"),
        );
        const manifest = JSON.parse(
            await readFile(
                join(this.root, "marketplace/src/attached/claude/plugin/.claude-plugin/plugin.json"),
                "utf8",
            ),
        );
        const versionFile = await readFile(join(this.checkout, "src/shared/version.js"), "utf8");
        const coreVersion = /VERSION\s*=\s*["']([^"']+)["']/.exec(versionFile)?.[1];
        if (!coreVersion) throw new PrerequisiteError("core-version");
        this.source = await captureCoreSource(this.checkout);
        // Installation used a copy; it must match the source whose fingerprint we record.
        for (const file of this.source.files.filter((file) => file.path.startsWith("src/attached/claude/plugin/"))) {
            const copied = await readFile(join(this.root, "marketplace", file.path));
            if (createHash("sha256").update(copied).digest("hex") !== file.sha256)
                throw new Error("Plugin source changed during preparation");
        }
        const metadata = {
            testDate: new Date().toISOString(),
            claudeVersion: match[1],
            coreVersion,
            coreCommit: this.source.commit,
            coreSourceDigest: this.source.digest,
            coreSourceDirty: this.source.dirty,
            coreSourceFiles: this.source.files.map(({ path, sha256 }) => ({ path, sha256 })),
            adapterContract: descriptor.adapterContract,
            adapterVersion: manifest.version,
            permissions: "bypass-in-throwaway",
        };
        await writeFile(join(this.root, "run.json"), JSON.stringify(metadata, null, 2));
        return metadata;
    }
    async verifySource(): Promise<void> {
        if (!this.source) return;
        const after = await captureCoreSource(this.checkout);
        const metadata = JSON.parse(await readFile(join(this.root, "run.json"), "utf8"));
        metadata.coreSourceDigestAfter = after.digest;
        metadata.coreCommitAfter = after.commit;
        await writeFile(join(this.root, "run.json"), JSON.stringify(metadata, null, 2));
        if (this.source.digest !== after.digest || this.source.commit !== after.commit)
            this.issues.push("Core source changed during acceptance");
    }
    startHost(runId: string, phase: string): ClaudeHost {
        return new ClaudeHost({
            root: this.root,
            cwd: this.fixture,
            claude: this.claude,
            env: this.claudeEnv,
            runId,
            phase,
        });
    }
    status(): JsonMap {
        return (
            jsonMap(
                JSON.parse(
                    execFileSync(join(this.root, "bin/wld"), ["attached", "status"], {
                        cwd: this.fixture,
                        env: this.claudeEnv,
                        input: "{}",
                        encoding: "utf8",
                        timeout: 30_000,
                    }),
                ),
            ) ?? {}
        );
    }
    async snapshot(phase: Phase, hostRun: string | null): Promise<Snapshot> {
        const snapshot = await captureSnapshot(this.root, hostRun);
        await writeFile(join(this.root, "snapshots", `${phase}.json`), JSON.stringify(snapshot));
        if (snapshot.errors.length) throw new Error(`Snapshot capture failed: ${phase}`);
        return snapshot;
    }
    async waitForCiStart(host: ClaudeHost, beforeCount: number, timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        let replies = 0;
        while (true) {
            if (Date.now() >= deadline) throw new Error("Core CI did not start before the deadline");
            const runs = (await readFile(join(this.root, "markers/ci-runs"), "utf8"))
                .split(/\r?\n/)
                .filter(Boolean).length;
            if (runs === beforeCount + 1) return;
            if (runs !== beforeCount) throw new Error("CI marker count changed unexpectedly");
            if (host.readyForInput) {
                if (++replies > 5) throw new Error("Claude did not start Core CI after the user command answer");
                host.send(
                    `My selected test command is ${VERIFICATION_COMMAND}. Use that answer if Core asks for the test command, then continue RunWield validation. Keep Core's guards and the existing check.sh unchanged. Report any other blocking decision instead of choosing for me.`,
                );
            }
            await delay(100);
        }
    }
    async interruptCi(host: ClaudeHost): Promise<void> {
        const runs = (await readFile(join(this.root, "markers/ci-runs"), "utf8")).trim().split("\n");
        const ciPid = Number(runs.at(-1));
        if (!Number.isSafeInteger(ciPid) || ciPid <= 0) throw new Error("CI process identity is missing");
        process.kill(ciPid, "SIGSTOP");
        try {
            const finished = (await readFile(join(this.root, "markers/ci-finished"), "utf8")).trim().split("\n");
            if (finished.includes(String(ciPid))) throw new Error("CI completed before the scripted interruption");
            await this.snapshot("ci-started", host.options.runId);
            await appendFile(
                join(this.root, "logs/processes.jsonl"),
                JSON.stringify({ event: "ci-held", phase: "ci-killed", runId: host.options.runId, ciPid }) + "\n",
            );
            await host.stop("ci-killed", "SIGKILL");
            await this.snapshot("ci-killed", host.options.runId);
        } finally {
            try {
                process.kill(ciPid, "SIGCONT");
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
            }
        }
    }
    async checkInstrumentation(executionCwd: string): Promise<void> {
        if ((await readFile(join(executionCwd, "check.sh"), "utf8")) !== CHECK)
            throw new Error("Fixture CI instrumentation changed");
    }
    async close(): Promise<void> {
        if (this.proxy.listening)
            await new Promise<void>((resolve, reject) =>
                this.proxy.close((error) => (error ? reject(error) : resolve())),
            );
    }
    async discardPrivateFiles(): Promise<void> {
        for (const file of [
            "fixture",
            "runwield-home",
            "claude-home",
            "claude-config",
            "tmp",
            "bin",
            "sentinels",
            "logs",
            "snapshots",
            "markers",
            "marketplace",
            "stale-marketplace",
            "markers",
            "shim-argv.jsonl",
            "sentinel-binaries.log",
            "proxy-sink.log",
            "run.json",
        ])
            await rm(join(this.root, file), { recursive: true, force: true });
    }
}
