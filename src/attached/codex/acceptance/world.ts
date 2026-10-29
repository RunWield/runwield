import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, lstat, writeFile, rm } from "node:fs/promises";
import { join, resolve, delimiter } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { captureCoreSource } from "../../claude/acceptance/source.ts";
import { captureSnapshot, collectPrivacyEvidence } from "../../claude/acceptance/collector.ts";
import { CodexHost } from "./host.ts";
import { field, type JsonMap, type SourceEvidence } from "./evidence.ts";

export class PrerequisiteError extends Error {
    constructor(readonly prerequisite: string) {
        super(`Acceptance prerequisite unavailable: ${prerequisite}`);
    }
}
export interface WorldOptions {
    root: string;
    checkout: string;
    codex: string;
}
/** Keep host authentication in place without reusing the parent task's identity or app-tool socket. */
export function isolatedLiveHostEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return Object.fromEntries(
        Object.entries(env).filter(([name]) => !name.startsWith("CODEX_") || name === "CODEX_HOME"),
    );
}
export class AcceptanceWorld {
    readonly root: string;
    readonly checkout: string;
    readonly fixture: string;
    readonly sentinel = `ordinary-codex-${randomUUID()}`;
    readonly codex: string;
    readonly env: NodeJS.ProcessEnv;
    readonly coreEnv: NodeJS.ProcessEnv;
    private source: SourceEvidence | null = null;
    private hosts: CodexHost[] = [];
    constructor(options: WorldOptions) {
        this.root = resolve(options.root);
        this.checkout = resolve(options.checkout);
        this.codex = options.codex;
        this.fixture = join(this.root, "fixture");
        const path = `${join(this.root, "bin")}${delimiter}${process.env.PATH ?? ""}`;
        this.env = { ...process.env, CODEX_HOME: join(this.root, "codex-home"), PATH: path };
        this.coreEnv = {
            HOME: join(this.root, "runwield-home"),
            USERPROFILE: join(this.root, "runwield-home"),
            PATH: path,
            TMPDIR: join(this.root, "tmp"),
            LANG: "en_US.UTF-8",
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
            ACCEPTANCE_MARKER_DIR: join(this.root, "markers"),
        };
    }
    async create(): Promise<void> {
        try {
            const stat = await lstat(this.root);
            if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(this.root)).length)
                throw new Error("Evidence directory must be new or empty");
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        for (const directory of [
            "fixture",
            "runwield-home/.wld",
            "codex-home",
            "tmp",
            "bin",
            "logs",
            "snapshots",
            "markers",
            "marketplace/.agents/plugins",
        ])
            await mkdir(join(this.root, directory), { recursive: true, mode: 0o700 });
        for (const file of [
            "host-evidence.jsonl",
            "handshakes.jsonl",
            "shim-argv.jsonl",
            "logs/http.jsonl",
            "markers/ci-runs",
            "markers/ci-finished",
        ])
            await writeFile(join(this.root, file), "", { flag: "wx", mode: 0o600 });
        await writeFile(join(this.fixture, "README.md"), "# Codex Connect acceptance fixture\n");
        await writeFile(
            join(this.fixture, "check.sh"),
            `#!/bin/sh\nset -eu\ntrap 'printf "%s\\n" "$$" >> "$ACCEPTANCE_MARKER_DIR/ci-finished"' EXIT\nprintf '%s\\n' "$$" >> "$ACCEPTANCE_MARKER_DIR/ci-runs"\nsleep 65\ntest "$(sh ./greet.sh Ada)" = 'Hello, Ada!'\ntest "$(sh ./greet.sh 'Ada Lovelace')" = 'Hello, Ada Lovelace!'\nif sh ./greet.sh >/dev/null 2>missing-name.stderr; then exit 1; fi\ngrep -qi usage missing-name.stderr\n`,
            { mode: 0o755 },
        );
        this.git(["init", "-b", "main"]);
        this.git(["config", "user.name", "Acceptance Fixture"]);
        this.git(["config", "user.email", "acceptance@example.invalid"]);
        this.git(["config", "core.excludesFile", "/dev/null"]);
        await writeFile(join(this.fixture, ".git/info/exclude"), "missing-name.stderr\n");
        this.git(["add", "README.md", "check.sh"]);
        this.git(["commit", "-m", "Create acceptance fixture"]);
        await writeFile(
            join(this.root, "runwield-home/.wld/settings.json"),
            JSON.stringify({ verification_command: "sh ./check.sh", codereview: "always" }),
        );
        await writeFile(
            join(this.root, "bin/wld"),
            `#!${process.execPath}
import {spawn} from "node:child_process";
import {appendFileSync} from "node:fs";
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(join(this.root, "shim-argv.jsonl"))},JSON.stringify(args)+"\\n");
const env=${JSON.stringify(this.coreEnv)};
if(process.env.RUNWIELD_ATTACHED_PLUGIN_ROOT)env.RUNWIELD_ATTACHED_PLUGIN_ROOT=process.env.RUNWIELD_ATTACHED_PLUGIN_ROOT;
const child=spawn(${JSON.stringify(process.execPath)},["--no-env-file",${JSON.stringify(join(this.checkout, "src/cli.ts"))},...args],{env,stdio:["pipe","pipe","pipe"]});
let buffer="";
process.stdin.on("data",bytes=>{
 buffer+=bytes.toString();let newline;
 while((newline=buffer.indexOf("\\n"))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
  try{const message=JSON.parse(line);if(message.method==="initialize")appendFileSync(${JSON.stringify(join(this.root, "handshakes.jsonl"))},JSON.stringify({clientInfo:message.params?.clientInfo,capabilities:Object.keys(message.params?.capabilities??{})})+"\\n");}catch{}
 }
 child.stdin.write(bytes);
});
process.stdin.on("end",()=>child.stdin.end());child.stdout.pipe(process.stdout);child.stderr.resume();
for(const signal of ["SIGTERM","SIGINT"])process.on(signal,()=>child.kill(signal));
child.on("error",()=>process.exit(1));child.on("close",code=>process.exit(code??1));
`,
            { mode: 0o755 },
        );
    }
    git(args: string[]): string {
        return execFileSync("git", args, {
            cwd: this.fixture,
            env: { ...this.coreEnv, PATH: process.env.PATH },
            encoding: "utf8",
            timeout: 30_000,
        }).trim();
    }
    async prepare(): Promise<{
        hostVersion: string;
        source: SourceEvidence;
        adapterVersion: string;
        adapterContract: number;
    }> {
        let version: string;
        try {
            version = execFileSync(this.codex, ["--version"], {
                encoding: "utf8",
                env: this.env,
                timeout: 15_000,
            }).trim();
        } catch {
            throw new PrerequisiteError("codex-executable");
        }
        const match = /^codex-cli (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(version);
        if (!match) throw new PrerequisiteError("codex-version");
        const sourcePlugin = join(this.checkout, "src/attached/codex/plugin");
        let manifest: JsonMap, descriptor: JsonMap;
        try {
            manifest = JSON.parse(await readFile(join(sourcePlugin, ".codex-plugin/plugin.json"), "utf8"));
            descriptor = JSON.parse(await readFile(join(sourcePlugin, "runwield-adapter.json"), "utf8"));
        } catch {
            throw new PrerequisiteError("codex-plugin-package");
        }
        if (typeof manifest.version !== "string" || typeof descriptor.adapterContract !== "number")
            throw new PrerequisiteError("codex-plugin-metadata");
        const destination = join(this.root, "marketplace/src/attached/codex/plugin");
        await cp(sourcePlugin, destination, { recursive: true });
        const catalog = join(this.checkout, ".agents/plugins/marketplace.json");
        await cp(catalog, join(this.root, "marketplace/.agents/plugins/marketplace.json"));
        const source = await captureCoreSource(this.checkout);
        const catalogDigest = createHash("sha256")
            .update(await readFile(catalog))
            .digest("hex");
        this.source = {
            commit: source.commit,
            dirty: source.dirty,
            digest: createHash("sha256")
                .update(source.digest + catalogDigest)
                .digest("hex"),
        };
        await writeFile(
            join(this.root, "source.json"),
            JSON.stringify(
                { ...this.source, files: source.files.map(({ path, sha256 }) => ({ path, sha256 })), catalogDigest },
                null,
                2,
            ),
            { mode: 0o600 },
        );
        return {
            hostVersion: match[1],
            source: this.source,
            adapterVersion: manifest.version,
            adapterContract: descriptor.adapterContract,
        };
    }
    plugin(args: string[]): void {
        try {
            execFileSync(this.codex, ["plugin", ...args], {
                cwd: this.fixture,
                env: this.env,
                stdio: ["ignore", "pipe", "pipe"],
                timeout: 60_000,
            });
        } catch {
            throw new Error("Isolated Codex plugin command failed");
        }
    }
    install(): void {
        this.plugin(["marketplace", "add", join(this.root, "marketplace")]);
        this.plugin(["add", "runwield@runwield"]);
    }
    protocolHost(run: string): CodexHost {
        const host = new CodexHost({
            executable: this.codex,
            cwd: this.fixture,
            root: this.root,
            env: this.env,
            run,
            args: ["app-server", "-c", "features.apps=false", "-c", "mcp_optional_startup_grace_ms=0"],
        });
        this.hosts.push(host);
        return host;
    }
    async liveHost(run: string, prompt: string): Promise<CodexHost> {
        const packageConfig: JsonMap = JSON.parse(
            await readFile(join(this.root, "marketplace/src/attached/codex/plugin/.mcp.json"), "utf8"),
        );
        const server = field(packageConfig, "mcpServers", "runwield");
        if (!server || Array.isArray(server) || typeof server !== "object")
            throw new Error("Plugin lacks RunWield MCP configuration");
        const host = new CodexHost({
            executable: this.codex,
            cwd: this.fixture,
            root: this.root,
            env: { ...isolatedLiveHostEnv(process.env), PATH: this.env.PATH },
            run,
            args: ["app-server", "-c", "features.plugins=false", "-c", "features.apps=false"],
        });
        this.hosts.push(host);
        await host.initializeTransport();
        // Read configuration in memory; never copy it or save credential-bearing fields.
        const current = await host.request("config/read", { includeLayers: false });
        const inherited = field(current, "config", "mcp_servers");
        const servers: JsonMap = {};
        if (inherited && !Array.isArray(inherited) && typeof inherited === "object")
            for (const name of Object.keys(inherited)) servers[name] = { enabled: false };
        servers.runwield = { ...server, command: join(this.root, "bin/wld"), enabled: true };
        await host.startThread({
            sandbox: "danger-full-access",
            experimentalRawEvents: true,
            config: { mcp_servers: servers },
        });
        const inventory = await host.inventory();
        const entries = Array.isArray(inventory.data) ? inventory.data : [];
        if (
            !entries.some(
                (entry) => field(entry, "name") === "runwield" && field(entry, "runtimeStatus") === "connected",
            ) ||
            entries.some((entry) => field(entry, "name") !== "runwield" && field(entry, "runtimeStatus") !== "disabled")
        )
            throw new Error("The live host did not isolate its MCP configuration");
        await host.startTurn(prompt);
        return host;
    }
    async prepareLive(): Promise<void> {
        try {
            await readFile(join(this.checkout, "dist/workspace-bun/server/entry.mjs"));
        } catch {
            throw new PrerequisiteError("workspace-assets");
        }
        try {
            execFileSync("mnemoteca", ["setup"], {
                cwd: this.fixture,
                env: { ...this.coreEnv, PATH: process.env.PATH },
                timeout: 300_000,
                stdio: ["ignore", "pipe", "pipe"],
            });
        } catch {
            throw new PrerequisiteError("mnemoteca");
        }
        const directory = join(this.root, "runwield-home/.wld/agents/shared-practice");
        await mkdir(directory, { recursive: true });
        const practice = await readFile(
            join(this.checkout, "src/agent-definitions/shared-practice/review-practice.md"),
            "utf8",
        );
        await writeFile(
            join(directory, "review-practice.md"),
            practice +
                "\n\n## Acceptance fixture rule\n\nRead NOTES.md in the execution checkout. If it lacks the exact line `acceptance: reviewed`, report a blocking new finding titled `acceptance-notes` requiring that line. Do not edit. In re-review use Core's assigned finding ID and inspect the fix.\n",
        );
    }
    async snapshot(name: string, run: string | null): Promise<void> {
        const snapshot = await captureSnapshot(this.root, run);
        await writeFile(join(this.root, "snapshots", `${name}.json`), JSON.stringify(snapshot), { mode: 0o600 });
        if (snapshot.errors.length) throw new Error("Durable evidence could not be captured");
    }
    privacy() {
        return collectPrivacyEvidence(this.root, [this.sentinel]);
    }
    async sourceUnchanged(): Promise<boolean> {
        const source = await captureCoreSource(this.checkout);
        const catalogDigest = createHash("sha256")
            .update(await readFile(join(this.checkout, ".agents/plugins/marketplace.json")))
            .digest("hex");
        return (
            this.source?.commit === source.commit &&
            this.source.digest ===
                createHash("sha256")
                    .update(source.digest + catalogDigest)
                    .digest("hex")
        );
    }
    async close(): Promise<void> {
        await Promise.all(this.hosts.map((host) => host.stop()));
    }
    async discardPrivateFiles(): Promise<void> {
        for (const directory of ["codex-home", "snapshots", "tmp"])
            await rm(join(this.root, directory), { recursive: true, force: true });
    }
}
