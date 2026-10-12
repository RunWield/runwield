/** Qualify a relocated CLI turn against an isolated HTTP provider and external helper fixtures. */
import { equal, ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { argv, env, platform } from "node:process";

import { fileURLToPath } from "node:url";
import { installPackageHelperFixtures } from "./package-helper-fixtures.ts";

interface ProviderRequest {
    tools: Array<{ function: { name: string } }>;
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
if (argv.length < 3 || argv.length > 4) {
    throw new Error("Usage: check-bun-provider.ts <executable> [helper-fixture-path]");
}
const home = await mkdtemp(join(tmpdir(), "compiled-provider-"));
async function removeProviderHome(): Promise<void> {
    // Windows can briefly retain an executable mapping after the process close event.
    for (let attempt = 0; ; attempt++) {
        try {
            await rm(home, { recursive: true, force: true });
            break;
        } catch (error) {
            if (
                platform !== "win32" ||
                attempt >= 50 ||
                !(error instanceof Error) ||
                !("code" in error) ||
                (error.code !== "EBUSY" && error.code !== "EPERM")
            )
                throw error;
            await new Promise((done) => setTimeout(done, 100));
        }
    }
}

const marker = "Compiled provider turn completed.";
const requestTexts: string[] = [];
const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requestTexts.push(Buffer.concat(chunks).toString("utf8"));
    if (request.headers.authorization !== "Bearer fixture-key") {
        response.writeHead(401).end();
        return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
        `data: ${JSON.stringify({
            id: "fixture-response",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta: { role: "assistant", content: marker }, finish_reason: null }],
        })}\n\n`,
    );
    response.write(
        `data: ${JSON.stringify({
            id: "fixture-response",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
});
try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    ok(address && typeof address !== "string");
    const state = join(home, ".wld");
    const project = join(home, "project");
    const bin = join(home, "bin");
    await Promise.all([mkdir(state), mkdir(project), mkdir(bin)]);
    await installPackageHelperFixtures(bin, argv[3] || join(ROOT, "src/testing/workflow-binary-fixture.sh"));
    const models = {
        providers: {
            fixture: {
                name: "Local fixture",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: "fixture-key",
                api: "openai-completions",
                models: [
                    {
                        id: "fixture",
                        name: "Fixture",
                        api: "openai-completions",
                        reasoning: false,
                        input: ["text"],
                        contextWindow: 128000,
                        maxTokens: 4096,
                    },
                ],
            },
        },
    };
    await writeFile(join(state, "models.json"), JSON.stringify(models), { mode: 0o600 });
    await writeFile(join(state, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture-key" } }), {
        mode: 0o600,
    });
    await writeFile(
        join(state, "settings.json"),
        JSON.stringify({
            defaultProvider: "fixture",
            defaultModel: "fixture",
            notifications: { enabled: false },
            onboardingTutorialOfferHandled: true,
        }),
        { mode: 0o600 },
    );
    const executable = join(home, platform === "win32" ? "wld.exe" : "wld");
    await cp(resolve(argv[2]), executable);
    const prompt = "Say hello for migration qualification.";
    const command = platform === "darwin" ? "/usr/bin/sandbox-exec" : executable;
    const args =
        platform === "darwin"
            ? [
                  "-p",
                  `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(ROOT)}))`,
                  executable,
                  prompt,
              ]
            : [prompt];
    const child = spawn(command, args, {
        cwd: project,
        env: {
            ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
            ...(env.COMSPEC ? { COMSPEC: env.COMSPEC } : {}),
            ...(env.PATHEXT ? { PATHEXT: env.PATHEXT } : {}),
            HOME: home,
            USERPROFILE: home,
            TMPDIR: home,
            TEMP: home,
            TMP: home,
            PATH: `${bin}${delimiter}${env.PATH || "/usr/bin:/bin"}`,
            NO_COLOR: "1",
            MNEMOTECA_DB_PATH: join(home, "memory.db"),
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let declinedInit = false;
    let completed = false;
    let quitSent = false;
    let quitTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (chunk: string) => {
        output += chunk;
        if (!declinedInit && output.includes("Would you like to run /init")) {
            declinedInit = true;
            child.stdin.write("\x1b[B\r");
        }
        if (!completed && output.includes(marker)) {
            completed = true;
            quitTimer = setTimeout(() => {
                if (child.exitCode !== null || child.signalCode !== null || !child.stdin.writable) return;
                quitSent = true;
                child.stdin.write("/quit\r");
            }, 300);
        }
    };
    child.stdout.setEncoding("utf8").on("data", append);
    child.stderr.setEncoding("utf8").on("data", append);
    const finished = new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("close", done);
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
        equal(await finished, 0, output.slice(-6000));
        ok(completed, output.slice(-6000));
        ok(quitSent, "CLI remains interactive until the qualifier sends /quit");
        equal(requestTexts.length, 1);
        ok(requestTexts[0].includes("Say hello for migration qualification."));
        const body = JSON.parse(requestTexts[0]) as ProviderRequest;
        const names = body.tools.map((tool) => tool.function.name);
        ok(names.includes("memory"));
        ok(names.includes("code_search"));
        equal(output.includes("Extension warning"), false);
        equal(output.includes("Deno is not defined"), false);
        ok(output.includes("\x1b[?1049l"));
        ok(output.includes("\x1b[?25h"));
        let unexpected = "";
        try {
            unexpected = await readFile(join(bin, "unexpected.log"), "utf8");
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        equal(unexpected, "");
        console.log(
            "Compiled CLI passed: local HTTP provider turn, helper declarations, no extension warnings, normal /quit and terminal restoration.",
        );
    } finally {
        clearTimeout(timeout);
        clearTimeout(quitTimer);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await finished;
    }
} finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await removeProviderHome();
}
