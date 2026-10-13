import { serveHttp } from "../../shared/http-server.ts";
import { type NativeSpawnOptions, spawnNativeProcess } from "../../shared/foreground-process.ts";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { type CapturedProcessOutput } from "../../shared/captured-process.ts";
import { type NativeProcess } from "../../shared/foreground-process.ts";
import { collectProcessOutput } from "../../testing/subprocess-output.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { test } from "node:test";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { fileURLToPath as fromFileUrl } from "node:url";
import { join } from "node:path";
import { openOwnerCoordinationStore } from "../../shared/owner-coordination/index.js";
import { parseWorkspaceServeArgs } from "./serve.ts";

interface WorkspaceCommandFixture {
    databasePath: string;
    homeDir: string;
    origin: string;
    port: number;
    projectRoot: string;
}

interface PairingRequestBody {
    code: string;
    expiresAt: string;
    state: string;
}

interface PairingStatusBody {
    state: string;
}

const decoder = new TextDecoder();
const workspaceModuleUrl = import.meta.resolve("./index.ts");
const denoConfigPath = fromFileUrl(new URL("../../../deno.json", import.meta.url));

async function withWorkspaceCommandFixture(
    run: (fixture: WorkspaceCommandFixture) => Promise<void>,
): Promise<void> {
    const fixtureRoot = await fsMkdtemp(join(tmpdir(), "runwield-workspace-command-"));
    const homeDir = join(fixtureRoot, "home");
    const projectRoot = join(fixtureRoot, "project");
    await Promise.all([
        fsMkdir(homeDir, { recursive: true }),
        fsMkdir(projectRoot, { recursive: true }),
    ]);
    const listener = serveHttp({ hostname: "127.0.0.1", port: 0, onListen() {} }, () => new Response("reserved"));
    const port = listener.addr.port;
    await listener.shutdown();
    try {
        await run({
            databasePath: join(homeDir, ".wld", "owner-coordination.sqlite3"),
            homeDir,
            origin: `http://127.0.0.1:${port}`,
            port,
            projectRoot,
        });
    } finally {
        await fsRm(fixtureRoot, { recursive: true }).catch(() => {});
    }
}

function workspaceCommandSource(argv: string[]): string {
    return `import { runWorkspaceCommand } from ${JSON.stringify(workspaceModuleUrl)};\n` +
        `await runWorkspaceCommand(${JSON.stringify(argv)});\n`;
}

function workspaceCommandOptions(fixture: WorkspaceCommandFixture, argv: string[]): NativeSpawnOptions {
    return {
        args: runtimeSourceArgs(["eval", "--config", denoConfigPath, workspaceCommandSource(argv)]),
        cwd: fixture.projectRoot,
        env: {
            HOME: fixture.homeDir,
            WLD_TEST_SANDBOX_HOME: fixture.homeDir,
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
    };
}

async function runWorkspaceChild(
    fixture: WorkspaceCommandFixture,
    argv: string[],
): Promise<CapturedProcessOutput> {
    const { args, cwd, env } = workspaceCommandOptions(fixture, argv);
    return await captureForegroundProcess(process.execPath, { args, cwd, env });
}

async function waitForWorkspace(origin: string, serverChild: NativeProcess): Promise<Response> {
    let lastError: Error | undefined;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const exited = await Promise.race([
            serverChild.status.then((status) => ({ exited: true, status })),
            new Promise<{ exited: false }>((resolve) => setTimeout(() => resolve({ exited: false }), 25)),
        ]);
        if (exited.exited) {
            throw new Error(`Owner Workspace exited before it served /pair with code ${exited.status.code}.`);
        }
        try {
            const response = await fetch(`${origin}/pair`);
            if (response.ok || response.status === 503) return response;
            lastError = new Error(`Owner Workspace returned ${response.status} for /pair.`);
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
        }
    }
    throw lastError || new Error(`Owner Workspace did not start at ${origin}.`);
}

async function collectServerOutput(serverChild: NativeProcess): Promise<CapturedProcessOutput> {
    try {
        serverChild.kill("SIGINT");
    } catch {
        // The child already stopped; output below reports its result.
    }
    const output = collectProcessOutput(serverChild);
    return await Promise.race([
        output,
        new Promise<CapturedProcessOutput>((resolve, reject) => {
            setTimeout(async () => {
                try {
                    serverChild.kill("SIGKILL");
                } catch {
                    // The child already stopped.
                }
                try {
                    resolve(await output);
                } catch (error) {
                    reject(error);
                }
            }, 5_000);
        }),
    ]);
}

test("workspace serve parser defaults to loopback and rejects unsafe non-loopback", () => {
    assertEquals(parseWorkspaceServeArgs([]), {
        host: "127.0.0.1",
        port: 8787,
        publicOrigin: "http://127.0.0.1:8787",
        trustTlsTerminator: false,
        noOpen: false,
        help: false,
    });
    const safe = parseWorkspaceServeArgs([
        "--bind",
        "0.0.0.0",
        "--trust-tls-terminator",
        "--public-origin",
        "https://runwield.example.test:443",
    ]);
    assertEquals(safe.host, "0.0.0.0");
    assertEquals(safe.publicOrigin, "https://runwield.example.test");

    let message = "";
    try {
        parseWorkspaceServeArgs(["--bind", "0.0.0.0"]);
    } catch (error) {
        message = error instanceof Error ? error.message : String(error);
    }
    assertStringIncludes(message, "Non-loopback owner Workspace bind requires");
});

test("workspace help and validation use isolated command processes without creating owner state", async () => {
    await withWorkspaceCommandFixture(async (fixture) => {
        const help = await runWorkspaceChild(fixture, ["--help"]);
        assertEquals(help.code, 0);
        assertStringIncludes(decoder.decode(help.stdout), "workspace <command>");

        const serveHelp = await runWorkspaceChild(fixture, ["serve", "--help"]);
        assertEquals(serveHelp.code, 0);
        const serveHelpText = decoder.decode(serveHelp.stdout);
        assertStringIncludes(serveHelpText, "Phone access");
        assertStringIncludes(serveHelpText, "trusted HTTPS terminator");
        assertStringIncludes(serveHelpText, "--public-origin https://<tailnet-host>");

        const missingPairCode = await runWorkspaceChild(fixture, ["pair"]);
        assertEquals(missingPairCode.code, 0);
        assertStringIncludes(decoder.decode(missingPairCode.stderr), "Pairing code is required");

        const unsafeServe = await runWorkspaceChild(fixture, ["serve", "--bind", "0.0.0.0", "--no-open"]);
        assertEquals(unsafeServe.code, 0);
        assertStringIncludes(decoder.decode(unsafeServe.stderr), "Non-loopback owner Workspace bind requires");
        assertEquals(await fsStat(fixture.databasePath).then(() => true).catch(() => false), false);
    });
});

test("workspace serve and pair complete the real browser pairing lifecycle", async () => {
    await withWorkspaceCommandFixture(async (fixture) => {
        const serveArgs = [
            "serve",
            "--port",
            String(fixture.port),
            "--no-open",
        ];
        const serverChild = spawnNativeProcess(process.execPath, workspaceCommandOptions(fixture, serveArgs));
        let serverOutput: CapturedProcessOutput | undefined;
        try {
            const pairPage = await waitForWorkspace(fixture.origin, serverChild);
            const pairPageText = await pairPage.text();
            if (pairPage.status === 503) {
                assertStringIncludes(pairPageText, "Workspace Astro build unavailable");
            } else {
                assertStringIncludes(pairPageText, "Authorize this browser");
            }

            const request = await fetch(`${fixture.origin}/api/owner/pairing/request`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    origin: fixture.origin,
                },
                body: JSON.stringify({ deviceLabel: "Device \u001b[31mRed\u0007" }),
            });
            assertEquals(request.status, 201);
            const pairing = await request.json() as PairingRequestBody;
            assertEquals(pairing.state, "pending");
            assertEquals(/^[A-Z2-9]{6}$/.test(pairing.code), true);
            assertEquals(typeof pairing.expiresAt, "string");
            const proofCookie = (request.headers.get("set-cookie") || "").split(";", 1)[0];
            assertStringIncludes(proofCookie, "rw_pairing_proof=");

            const pair = await runWorkspaceChild(fixture, ["pair", pairing.code.toLowerCase()]);
            const pairStdout = decoder.decode(pair.stdout);
            assertEquals(pair.code, 0);
            assertStringIncludes(pairStdout, "Approved Workspace pairing request for Device Red.");
            assertEquals(pairStdout.includes("\u001b"), false);
            assertEquals(pairStdout.includes("\u0007"), false);

            const statusResponse = await fetch(`${fixture.origin}/api/owner/pairing/status`, {
                headers: { cookie: proofCookie },
            });
            assertEquals(statusResponse.status, 200);
            assertEquals((await statusResponse.json() as PairingStatusBody).state, "approved");

            const claim = await fetch(`${fixture.origin}/api/owner/pairing/claim`, {
                method: "POST",
                headers: { cookie: proofCookie, origin: fixture.origin },
            });
            assertEquals(claim.status, 201);
            assertStringIncludes(claim.headers.get("set-cookie") || "", "rw_owner_device=");
        } finally {
            serverOutput = await collectServerOutput(serverChild);
        }

        // The test stops the long-running child after the lifecycle succeeds.
        // Deno may report graceful shutdown, SIGINT, or SIGKILL if cleanup had to force the child down.
        assertEquals([0, 130, 137].includes(serverOutput.code), true);
        assertStringIncludes(decoder.decode(serverOutput.stdout), `[RunWield] Owner Workspace: ${fixture.origin}`);
        assertStringIncludes(decoder.decode(serverOutput.stdout), `[RunWield] Owner database: ${fixture.databasePath}`);
        const store = openOwnerCoordinationStore({ dbPath: fixture.databasePath });
        try {
            assertEquals(store.listDevices().length, 1);
        } finally {
            store.close();
        }
    });
});
