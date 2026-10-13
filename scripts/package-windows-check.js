import { getCwd } from "../src/constants.js";
import { spawnNativeProcess } from "../src/shared/foreground-process.ts";
import { collectProcessOutput } from "../src/testing/subprocess-output.ts";
import { tmpdir } from "node:os";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
/**
 * Native Windows package smoke checks for a built RunWield ZIP.
 */

import { basename, join } from "node:path";
import { makeManagedSessionFixture } from "../src/testing/managed-session-fixture.ts";

function usage() {
    return "Usage: package-windows-check.js --package <wld-*-windows-x64.zip>";
}

/** @param {string[]} args */
function parseArgs(args) {
    const options = { packagePath: "" };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--package") options.packagePath = args[++index] || "";
        else throw new Error(`Unknown package:windows:check option: ${arg}\n${usage()}`);
    }
    if (!options.packagePath) throw new Error(usage());
    return options;
}

/** @param {string} command @param {string[]} args @param {{ cwd?: string, env?: Record<string, string>, stdin?: string }} [options] */
async function run(command, args, options = {}) {
    const child = spawnNativeProcess(command, {
        args,
        cwd: options.cwd ?? getCwd(),
        env: options.env,
        stdin: options.stdin === undefined ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
    });
    if (options.stdin !== undefined) {
        const writer = child.stdin.getWriter();
        await writer.write(new TextEncoder().encode(options.stdin));
        await writer.close();
    }
    const result = await collectProcessOutput(child);
    const decoder = new TextDecoder();
    const stdout = decoder.decode(result.stdout);
    const stderr = decoder.decode(result.stderr);
    if (!result.success) throw new Error(`${command} ${args.join(" ")} failed\n${stdout}${stderr}`);
    return { stdout, stderr };
}

/** @param {string} path */
async function assertFile(path) {
    const stat = await fsStat(path).catch(() => null);
    if (!stat?.isFile()) throw new Error(`Package check missing file: ${path}`);
}

/**
 * @typedef {Object} AcpRunWieldMetadata
 * @property {string} [persistedSessionId]
 * @property {string} [runtimeSessionId]
 * @property {string} [sessionPath]
 */

/**
 * @typedef {Object} AcpResult
 * @property {number} [protocolVersion]
 * @property {{ name?: string }} [agentInfo]
 * @property {{ name?: string }[]} [authMethods]
 * @property {string} [sessionId]
 * @property {{ runwield?: AcpRunWieldMetadata }} [_meta]
 */

/**
 * @typedef {Object} AcpMessage
 * @property {string | number} [id]
 * @property {AcpResult} [result]
 */

/**
 * @param {ReadableStream<Uint8Array>} stream
 * @param {AcpMessage[]} messages
 */
async function collectAcpOutput(stream, messages) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = "";
    let pending = "";
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        output += text;
        pending += text;
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
            const line = pending.slice(0, newline).trim();
            pending = pending.slice(newline + 1);
            if (line) messages.push(JSON.parse(line));
            newline = pending.indexOf("\n");
        }
    }
    const finalText = decoder.decode();
    output += finalText;
    pending += finalText;
    if (pending.trim()) messages.push(JSON.parse(pending));
    return output;
}

/** @param {AcpMessage[]} messages @param {string} id */
async function waitForAcpResponse(messages, id) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (messages.some((message) => message.id === id)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`ACP response ${id} timed out.`);
}

/**
 * @param {string} exe
 * @param {Record<string, string>} env
 * @param {Record<string, unknown>[]} requests
 * @returns {Promise<AcpMessage[]>}
 */
async function runAcpExchange(exe, env, requests) {
    const child = spawnNativeProcess(exe, {
        args: ["--mode", "acp"],
        cwd: getCwd(),
        env,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    });
    const writer = child.stdin.getWriter();
    const encoder = new TextEncoder();
    /** @type {AcpMessage[]} */
    const messages = [];
    const stdoutPromise = collectAcpOutput(child.stdout, messages);
    const stderrPromise = new Response(child.stderr).text();
    const initialize = {
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: { _meta: { "terminal-auth": true } } },
    };
    try {
        await writer.write(encoder.encode(`${JSON.stringify(initialize)}\n`));
        await waitForAcpResponse(messages, "initialize");
        for (const request of requests) {
            await writer.write(encoder.encode(`${JSON.stringify(request)}\n`));
            if (typeof request.id === "string") await waitForAcpResponse(messages, request.id);
        }
        await writer.close();
        const status = await Promise.race([
            child.status,
            new Promise((_, reject) => setTimeout(() => reject(new Error("ACP process exit timed out.")), 10_000)),
        ]);
        const stdout = await stdoutPromise;
        const stderr = await stderrPromise;
        if (!status.success) throw new Error(`ACP protocol exchange exited with ${status.code}.\n${stdout}${stderr}`);
        return messages;
    } catch (error) {
        try {
            child.kill();
        } catch {
            // Process already exited.
        }
        await writer.close().catch(() => {});
        const stdout = await stdoutPromise.catch(() => "");
        const stderr = await stderrPromise.catch(() => "");
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}\n${stdout}${stderr}`);
    }
}

/** @param {string} exe @param {Record<string, string>} env */
async function checkAcpProtocolExchange(exe, env) {
    const messages = await runAcpExchange(exe, env, [
        {
            jsonrpc: "2.0",
            id: "session-new",
            method: "session/new",
            params: { cwd: env.LOCALAPPDATA, mcpServers: [] },
        },
    ]);
    const initialized = messages.find((message) => message.id === "initialize");
    if (initialized?.result?.protocolVersion !== 1 || initialized?.result?.agentInfo?.name !== "RunWield") {
        throw new Error(`ACP initialize response was incomplete:\n${JSON.stringify(messages)}`);
    }
    const authMethods = Array.isArray(initialized.result.authMethods) ? initialized.result.authMethods : [];
    if (!authMethods.some((method) => method.name === "RunWield Login")) {
        throw new Error(`ACP initialize did not advertise terminal login:\n${JSON.stringify(messages)}`);
    }
    const sessionNew = messages.find((message) => message.id === "session-new");
    const persistedSessionId = sessionNew?.result?._meta?.runwield?.persistedSessionId;
    if (!sessionNew?.result?.sessionId || !persistedSessionId) {
        throw new Error(`ACP session/new did not create a persisted Session:\n${JSON.stringify(messages)}`);
    }

    const loaded = await runAcpExchange(exe, env, [
        {
            jsonrpc: "2.0",
            id: "load-saved-session",
            method: "session/load",
            params: { cwd: env.LOCALAPPDATA, sessionId: persistedSessionId, mcpServers: [] },
        },
    ]);
    const loadedMetadata = loaded.find((message) => message.id === "load-saved-session")?.result?._meta?.runwield;
    if (!loadedMetadata?.persistedSessionId || !loadedMetadata?.runtimeSessionId || !loadedMetadata?.sessionPath) {
        throw new Error(`ACP session/load did not resume the saved Session:\n${JSON.stringify(loaded)}`);
    }
}

/** @param {string} exe @param {Record<string, string>} env */
async function checkCoreHelperFlows(exe, env) {
    await run(exe, ["package-smoke", "core-flows"], { env: { ...env, WLD_INTERNAL_PACKAGE_CHECK: "1" } });
}

/** @param {string} exe @param {Record<string, string>} env */
async function checkProviderSetupLaunch(exe, env) {
    const child = spawnNativeProcess(exe, {
        args: ["login", "api-key", "openai"],
        cwd: getCwd(),
        env,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    });
    const writer = child.stdin.getWriter();
    const encoder = new TextEncoder();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await writer.write(encoder.encode("sk-runwield-package-smoke"));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await writer.write(encoder.encode("\r"));
    await writer.close();
    const timeout = setTimeout(() => {
        try {
            child.kill();
        } catch {
            // Process already exited.
        }
    }, 5_000);
    try {
        const output = await collectProcessOutput(child);
        const text = `${new TextDecoder().decode(output.stdout)}${new TextDecoder().decode(output.stderr)}`;
        const authText = await fsReadFile(join(env.USERPROFILE, ".wld", "auth.json"), "utf8").catch(() => "");
        if (!authText.includes("openai")) {
            throw new Error(`Provider setup did not persist the package-check credential:\n${text}`);
        }
        await fsWriteFile(
            join(env.USERPROFILE, ".wld", "settings.json"),
            JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4.1", notifications: { enabled: false } }),
        );
    } finally {
        clearTimeout(timeout);
    }
}

/** @typedef {{ planId?: string }} DashboardSmokeItem */
/** @typedef {{ key: string, items: DashboardSmokeItem[] }} DashboardSmokeSection */
/** @typedef {{ pending: boolean, failed: boolean }} DashboardSmokeSectionProgress */
/** @typedef {{ pending: boolean, totalProjects: number }} DashboardSmokeProgress */
/** @typedef {{ source: string, message: string }} DashboardSmokeDiagnostic */
/**
 * @typedef {Object} DashboardSmokeFrame
 * @property {string} type
 * @property {DashboardSmokeProgress} [progress]
 * @property {DashboardSmokeSection[]} [sections]
 * @property {DashboardSmokeDiagnostic[]} [diagnostics]
 * @property {Record<string, DashboardSmokeSectionProgress>} [sectionProgress]
 */

/** @param {string} exe @param {Record<string, string>} env */
async function checkWorkspacePairingAndArtifacts(exe, env) {
    const home = env.USERPROFILE;
    const projectRoot = join(home, "workspace-artifact-project");
    const fixture = await makeManagedSessionFixture({ home, projectRoot });
    try {
        await fsMkdir(join(projectRoot, "docs", "plans"), { recursive: true });
        await fsWriteFile(
            join(projectRoot, "docs", "plans", "dashboard-smoke.md"),
            `---\nplanId: windows-dashboard-smoke\nclassification: FEATURE\nstatus: user_verified\nuserVerifiedAt: "${
                new Date().toISOString()
            }"\n---\n# Windows Dashboard smoke\n`,
        );
        await fsWriteFile(
            join(projectRoot, "artifact.md"),
            "# Windows package artifact\n\nWorkspace artifact smoke.\n",
        );
        const artifact = fixture.registerArtifact("artifact.md", "Windows package artifact");

        const port = 48_787;
        const server = spawnNativeProcess(exe, {
            args: ["workspace", "serve", "--port", String(port), "--no-open"],
            cwd: getCwd(),
            stdin: "null",
            env,
            stdout: "piped",
            stderr: "piped",
        });
        try {
            const origin = `http://127.0.0.1:${port}`;
            for (let attempt = 0; attempt < 50; attempt += 1) {
                if (await fetch(`${origin}/pair`).then((response) => response.ok).catch(() => false)) break;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            const pairing = await fetch(`${origin}/api/owner/pairing/request`, {
                method: "POST",
                headers: { "content-type": "application/json", origin },
                body: JSON.stringify({ deviceLabel: "Windows package check" }),
            });
            if (pairing.status !== 201) throw new Error(`Workspace pairing request failed with ${pairing.status}.`);
            const proofCookie = pairing.headers.get("set-cookie")?.match(/rw_pairing_proof=([^;]+)/)?.[1];
            const { code } = await pairing.json();
            if (!code || !proofCookie) throw new Error("Workspace pairing did not return a code and proof cookie.");
            await run(exe, ["workspace", "pair", code], { env });
            const claim = await fetch(`${origin}/api/owner/pairing/claim`, {
                method: "POST",
                headers: { cookie: `rw_pairing_proof=${proofCookie}`, origin },
            });
            if (claim.status !== 201) throw new Error(`Workspace pairing claim failed with ${claim.status}.`);
            const deviceCookie = claim.headers.get("set-cookie")?.match(/rw_owner_device=([^;]+)/)?.[1];
            if (!deviceCookie) throw new Error("Workspace pairing did not issue an owner device cookie.");
            const dashboardResponse = await fetch(`${origin}/api/owner/dashboard/stream`, {
                headers: { cookie: `rw_owner_device=${deviceCookie}` },
                signal: AbortSignal.timeout(30_000),
            });
            const dashboardText = await dashboardResponse.text();
            const frames = dashboardText.trim().split("\n").filter(Boolean).map(
                /** @returns {DashboardSmokeFrame} */ (line) => JSON.parse(line),
            );
            const completed = frames.at(-1);
            if (
                dashboardResponse.status !== 200 || completed?.type !== "complete" ||
                completed.progress?.pending !== false || !((completed.progress?.totalProjects ?? 0) >= 1) ||
                completed.sections?.length !== 4 || completed.diagnostics?.length !== 0 ||
                ["needs-you", "ready", "in-progress", "recently-finished"].some((key) =>
                    completed.sectionProgress?.[key]?.failed !== false ||
                    completed.sectionProgress?.[key]?.pending !== false
                ) ||
                !completed.sections.some((section) =>
                    section.key === "recently-finished" &&
                    section.items.some((item) => item.planId === "windows-dashboard-smoke")
                )
            ) {
                throw new Error(`Packaged Dashboard did not load successfully:\n${dashboardText}`);
            }
            const artifactResponse = await fetch(
                `${origin}/projects/${fixture.project.projectId}/sessions/${fixture.session.runwieldSessionId}/artifacts/${artifact.artifactId}`,
                { headers: { cookie: `rw_owner_device=${deviceCookie}` } },
            );
            const artifactText = await artifactResponse.text();
            if (artifactResponse.status !== 200 || !artifactText.includes("Workspace artifact smoke")) {
                throw new Error(
                    `Workspace artifact retrieval failed with ${artifactResponse.status}:\n${artifactText}`,
                );
            }
            const wrongSession = await fetch(
                `${origin}/projects/${fixture.project.projectId}/sessions/missing/artifacts/${artifact.artifactId}`,
                { headers: { cookie: `rw_owner_device=${deviceCookie}` } },
            );
            if (wrongSession.status !== 404) {
                throw new Error(`Unrelated Session artifact returned ${wrongSession.status}.`);
            }
        } finally {
            server.kill("SIGTERM");
            await collectProcessOutput(server).catch(() => null);
        }
    } finally {
        await fixture.cleanup();
    }
}

/** @param {string} exe @param {Record<string, string>} env */
async function checkPublicationFlow(exe, env) {
    await run(exe, ["package-smoke", "publication"], { env: { ...env, WLD_INTERNAL_PACKAGE_CHECK: "1" } });
}

async function main(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    if (process.platform !== "win32") throw new Error("package:windows:check must run on native Windows.");
    const root = await fsMkdtemp(join(tmpdir(), "runwield-windows-check-"));
    try {
        const extract = join(root, "Run Wield Package");
        await fsMkdir(extract, { recursive: true });
        await run("powershell", [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath ${JSON.stringify(options.packagePath)} -DestinationPath ${
                JSON.stringify(extract)
            } -Force`,
        ]);
        const exe = join(extract, "wld.exe");
        for (
            const path of [
                "runtime/helpers/mnemoteca.exe",
                "runtime/helpers/cymbal.exe",
                "runtime/helpers/ketch.exe",
                "runtime/helpers/agent-browser.exe",
                "licenses/RUNWIELD-LICENSE.txt",
                "licenses/mnemoteca-LICENSE.txt",
                "licenses/cymbal-LICENSE.txt",
                "licenses/ketch-LICENSE.txt",
                "licenses/agent-browser-LICENSE.txt",
            ]
        ) await assertFile(join(extract, path));
        const metadata = JSON.parse(await fsReadFile(join(extract, "runwield-install.json"), "utf8"));
        if (metadata.packageManager !== "winget" || metadata.packageIdentifier !== "Gandazgul.RunWield") {
            throw new Error("Package metadata does not identify Gandazgul.RunWield WinGet ownership.");
        }
        const home = join(root, "User Profile");
        await fsMkdir(home, { recursive: true });
        const systemPath = process.env["SystemRoot"] ? `${process.env["SystemRoot"]}\\System32` : "";
        const hostPath = process.env["PATH"] || "";
        const cleanEnv = {
            HOME: "",
            USERPROFILE: home,
            APPDATA: join(home, "AppData", "Roaming"),
            LOCALAPPDATA: join(home, "AppData", "Local"),
            MNEMOTECA_DB_PATH: join(home, "AppData", "Local", "mnemoteca", "smoke.db"),
            PATH: [systemPath, hostPath].filter(Boolean).join(";"),
        };
        const version = await run(exe, ["--version"], { env: cleanEnv });
        const help = await run(exe, ["--help"], { env: cleanEnv });
        const update = await run(exe, ["update", "--rc"], { env: cleanEnv });
        if (!version.stdout.includes(`runwield ${metadata.version} (`)) {
            throw new Error("wld --version did not match package metadata.");
        }
        if (!help.stdout.toLowerCase().includes("usage")) throw new Error("wld --help did not print help.");
        if (!update.stdout.includes("winget upgrade --id Gandazgul.RunWield --exact")) {
            throw new Error("wld update did not print the WinGet upgrade command.");
        }
        await checkProviderSetupLaunch(exe, cleanEnv);
        await checkAcpProtocolExchange(exe, cleanEnv);
        await checkWorkspacePairingAndArtifacts(exe, cleanEnv);
        await checkPublicationFlow(exe, cleanEnv);
        await checkCoreHelperFlows(exe, cleanEnv);
        await run("cmd", ["/c", exe, "--version"], { env: cleanEnv });
        console.log(`${basename(options.packagePath)} passed native Windows package smoke checks.`);
    } finally {
        await fsRm(root, { recursive: true }).catch(() => {});
    }
}

if (import.meta.main) await main();
