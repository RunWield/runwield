/** Qualify a relocated development executable without touching the user's home. */
import { deepEqual, doesNotMatch, equal, match, ok } from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { argv, env, execPath, platform } from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { installPackageHelperFixtures } from "./package-helper-fixtures.ts";
import { verifyBuildArtifact } from "./build-metadata.ts";
import { captureScriptProcess } from "./script-process.ts";
import { removeExecutableFixtureDirectory } from "../src/testing/runtime-executable-fixture.ts";
import {
    SIDEBAR_MOTION_SOURCE,
    SIDEBAR_MOTION_URL,
    transpileSidebarMotionScript,
} from "../src/ui/workspace/server/public-workspace-assets.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function unusedPort(): Promise<number> {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("No TCP port allocated");
    await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
    return address.port;
}

export async function checkBunPackage(
    path: string,
    assetsDirectory = join(ROOT, "dist/workspace-bun/client"),
    helperFixturePath = join(ROOT, "src/testing/workflow-binary-fixture.sh"),
): Promise<void> {
    const executable = resolve(path);
    const metadata = await verifyBuildArtifact(executable);
    const home = await mkdtemp(join(tmpdir(), "runwield-bun-package-"));
    try {
        const relocated = join(home, platform === "win32" ? "wld.exe" : "wld");
        await cp(executable, relocated);
        // Both files must be ignored by the compiled executable.
        await writeFile(join(home, ".env"), "WLD_WORKSPACE_DISABLE_BUILT_SERVER=1\n");
        await writeFile(join(home, "bunfig.toml"), 'preload = ["./unexpected-preload.js"]\n');
        await writeFile(join(home, "unexpected-preload.js"), 'throw new Error("Ambient Bun config executed");\n');
        const childEnv = {
            ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
            ...(env.COMSPEC ? { COMSPEC: env.COMSPEC } : {}),
            ...(env.PATHEXT ? { PATHEXT: env.PATHEXT } : {}),
            HOME: home,
            USERPROFILE: home,
            TMPDIR: home,
            TEMP: home,
            TMP: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            XDG_CACHE_HOME: join(home, ".cache"),
            XDG_DATA_HOME: join(home, ".local/share"),
            MNEMOTECA_DB_PATH: join(home, "mnemoteca.db"),
            SNIP_DB_PATH: join(home, "snip.db"),
            PATH: env.PATH || "/usr/bin:/bin",
            WLD_INTERNAL_PACKAGE_CHECK: "1",
        };
        const start = (args: string[], cwd = home) => {
            // Deny the complete checkout to the executable, including dependencies,
            // while this verifier can still read expected bytes for comparison.
            const sandbox = `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(ROOT)}))`;
            const command = platform === "darwin" ? "/usr/bin/sandbox-exec" : relocated;
            // Qualification deliberately runs from its disposable home, not a user project.
            const acknowledgedArgs = ["--allow-system-directory", ...args];
            const commandArgs =
                platform === "darwin" ? ["-p", sandbox, relocated, ...acknowledgedArgs] : acknowledgedArgs;
            const child = spawn(command, commandArgs, { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
            let output = "";
            child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
            child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
            const finished = new Promise<number | null>((resolve, reject) => {
                child.once("error", reject);
                child.once("close", resolve);
            });
            return { child, finished, output: () => output };
        };
        for (const args of [
            ["--help"],
            ["--version"],
            ["plans"],
            ["package-smoke", "image-resize"],
            ["package-smoke", "codemode"],
            ["package-smoke", "skills"],
        ]) {
            const running = start(args);
            const timeout = setTimeout(() => running.child.kill("SIGKILL"), 30_000);
            try {
                equal(await running.finished, 0, running.output());
                if (args[0] === "--help") match(running.output(), /RunWield.*Plan-by-Default/s);
                else if (args[0] === "--version") ok(running.output().includes(metadata.version));
                else if (args[0] === "plans") match(running.output(), /No saved plans found/);
                else if (args[1] === "codemode") match(running.output(), /Packaged codemode passed/);
                else if (args[1] === "skills") match(running.output(), /Packaged skills passed/);
                else match(running.output(), /Packaged image resize passed/);
            } finally {
                clearTimeout(timeout);
            }
        }
        const project = join(home, "agent-project");
        const personalDefinitions = join(home, ".wld", "agents");
        const projectDefinitions = join(project, ".wld", "agents");
        const personalPrompt = `Personal Router instructions ${randomUUID()}.`;
        const projectPrompt = `Project Router instructions ${randomUUID()}.`;
        await mkdir(personalDefinitions, { recursive: true });
        await mkdir(projectDefinitions, { recursive: true });
        await writeFile(join(personalDefinitions, "router.md"), personalPrompt);
        await writeFile(join(projectDefinitions, "router.md"), projectPrompt);
        const agentCheck = start(["package-smoke", "agents"], project);
        const agentTimeout = setTimeout(() => agentCheck.child.kill("SIGKILL"), 30_000);
        try {
            equal(await agentCheck.finished, 0, agentCheck.output());
        } finally {
            clearTimeout(agentTimeout);
        }
        const source = await captureScriptProcess(execPath, {
            args: [
                "--no-env-file",
                "--no-install",
                join(ROOT, "src/cli.ts"),
                "--allow-system-directory",
                "package-smoke",
                "agents",
            ],
            cwd: project,
            env: childEnv,
            clearEnv: true,
            signal: AbortSignal.timeout(30_000),
        });
        const decoder = new TextDecoder();
        const sourceOutput = decoder.decode(source.stdout);
        equal(source.code, 0, sourceOutput + decoder.decode(source.stderr));
        const [personalHash, projectHash] = [personalPrompt, projectPrompt].map((prompt) =>
            createHash("sha256").update(prompt).digest("hex"),
        );
        for (const [runtime, output] of [
            ["Source", sourceOutput],
            ["Relocated package", agentCheck.output()],
        ]) {
            const paragraphs = output.match(/^Router prompt paragraphs ([a-f0-9,]+)$/m)?.[1]?.split(",");
            ok(
                paragraphs?.some((hash, index) => hash === personalHash && paragraphs[index + 1] === projectHash),
                `${runtime} must append the personal Router instructions before the project instructions.`,
            );
        }
        const digestPattern = /^Agent definitions ([a-f0-9]{64})$/m;
        const expected = sourceOutput.match(digestPattern)?.[1];
        ok(expected, sourceOutput);
        equal(agentCheck.output().match(digestPattern)?.[1], expected, agentCheck.output());
        for (const file of ["SKILL.md", "LICENSE"]) {
            deepEqual(
                await readFile(join(home, ".wld/bundled-skills/write-tests", file)),
                await readFile(join(ROOT, "src/skills/write-tests", file)),
                `Packaged write-tests/${file} must match the runtime source bytes`,
            );
        }
        // Qualify project moves with the actual shipped executable, not source imports.
        for (const keepAlias of [false, true]) {
            const original = join(home, `project-before-${keepAlias}`);
            const moved = join(home, `project-after-${keepAlias}`);
            await mkdir(original);
            const git = async (cwd: string, args: string[]) => {
                const result = await captureScriptProcess("git", { args, cwd, env: childEnv, clearEnv: true });
                ok(result.success, decoder.decode(result.stderr));
                return decoder.decode(result.stdout).trim();
            };
            await git(original, ["init", "-b", "main"]);
            const run = async (args: string[], cwd: string) => {
                const running = start(args, cwd);
                const timeout = setTimeout(() => running.child.kill("SIGKILL"), 30_000);
                try {
                    equal(await running.finished, 0, running.output());
                    return running.output();
                } finally {
                    clearTimeout(timeout);
                }
            };
            const planId = randomUUID();
            const planFile = join(original, "relocation.md");
            const summary = `Saved Plan ${planId} survives the checkout move.`;
            await writeFile(
                planFile,
                `---\nplanId: ${planId}\nstatus: draft\nsummary: ${summary}\n---\n# Relocation check\n`,
            );
            await run(["plans", "import", "relocation.md"], original);
            await unlink(planFile);
            const projectIdArgs = ["config", "--local", "--get", "runwield.projectid"];
            const projectId = await git(original, projectIdArgs);
            ok(projectId, "Import must bind the checkout to a project");
            const checkSavedPlan = async (cwd: string) => {
                ok((await run(["plans"], cwd)).includes(summary), "The packaged CLI must list the saved Plan");
                match(await run(["plans", "history", planId], cwd), /No milestones recorded/);
                equal(await git(cwd, projectIdArgs), projectId, "Moving the checkout must preserve its project ID");
            };
            await checkSavedPlan(original);
            await rename(original, moved);
            if (keepAlias) await symlink(moved, original, "junction");
            await checkSavedPlan(moved);
            if (keepAlias) await checkSavedPlan(original);
            await run(["plans", "doctor"], moved);
            await checkSavedPlan(moved);
        }
        const bin = join(home, "bin");
        await installPackageHelperFixtures(bin, helperFixturePath);
        childEnv.PATH = `${bin}${delimiter}${childEnv.PATH}`;
        const onboarding = start(["Runtime migration startup qualification"]);
        let reachedPicker = false;
        const cancelAtPicker = () => {
            if (!reachedPicker && onboarding.output().includes("Use an API key")) {
                reachedPicker = true;
                onboarding.child.stdin.write("\x1b");
            }
        };
        onboarding.child.stdout.on("data", cancelAtPicker);
        onboarding.child.stderr.on("data", cancelAtPicker);
        const onboardingTimeout = setTimeout(() => onboarding.child.kill("SIGKILL"), 30_000);
        try {
            equal(await onboarding.finished, 0, onboarding.output());
            ok(reachedPicker, onboarding.output());
            doesNotMatch(onboarding.output(), /Deno is not defined|Fatal error|ReferenceError/);
            ok(onboarding.output().includes("\x1b[?1049l"), "onboarding leaves the alternate screen");
            ok(onboarding.output().includes("\x1b[?25h"), "onboarding restores the cursor");
            let unexpected = "";
            try {
                unexpected = await readFile(join(bin, "unexpected.log"), "utf8");
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            }
            equal(unexpected, "");
        } finally {
            clearTimeout(onboardingTimeout);
            if (onboarding.child.exitCode === null && onboarding.child.signalCode === null) {
                onboarding.child.kill("SIGKILL");
            }
            await onboarding.finished;
        }
        const port = await unusedPort();
        const running = start(["workspace", "serve", "--port", String(port), "--no-open"]);
        const base = `http://127.0.0.1:${port}`;
        const watchdog = setTimeout(() => running.child.kill("SIGKILL"), 30_000);
        try {
            let page: Response | undefined;
            const deadline = Date.now() + 15_000;
            while (Date.now() < deadline && running.child.exitCode === null) {
                try {
                    page = await fetch(`${base}/pair`, { signal: AbortSignal.timeout(2_000) });
                    break;
                } catch {
                    await delay(50);
                }
            }
            ok(page, running.output());
            equal(page.status, 200, running.output());
            const html = await page.text();
            match(html, /Pair RunWield Workspace/);
            match(html, /data-workspace-sidebar-restore/);
            // The unbundled shell imports shared browser modules outside /_astro.
            // Qualify them from the relocated executable as well as hashed assets.
            const shellResponse = await fetch(`${base}/workspace-shell.js`);
            equal(shellResponse.status, 200);
            const shellSource = await shellResponse.text();
            match(shellSource, /installWorkspaceShellBrowser/);
            const imports = [...shellSource.matchAll(/from\s+["']([^"']+)["']/g)];
            ok(imports.length > 0);
            for (const [, specifier] of imports) {
                const assetUrl = new URL(specifier, `${base}/workspace-shell.js`);
                equal(assetUrl.origin, base);
                const response = await fetch(assetUrl);
                equal(response.status, 200, assetUrl.pathname);
                match(response.headers.get("content-type") || "", /(?:text|application)\/javascript/i);
                const sidebarMotion = assetUrl.pathname === SIDEBAR_MOTION_URL;
                const sourcePath = sidebarMotion ? SIDEBAR_MOTION_SOURCE : `src/ui${assetUrl.pathname}`;
                const source = await readFile(join(ROOT, sourcePath));
                const expected = sidebarMotion
                    ? new TextEncoder().encode(transpileSidebarMotionScript(source.toString("utf8")))
                    : new Uint8Array(source);
                deepEqual(new Uint8Array(await response.arrayBuffer()), expected, assetUrl.pathname);
            }
            equal(page.headers.get("x-frame-options"), "DENY");
            const assets = [...html.matchAll(/(?:src|href)="(\/_astro\/[^"?]+\.(?:js|css))"/g)].map((item) => item[1]);
            ok(assets.length > 0);
            for (const asset of new Set(assets)) {
                const response = await fetch(`${base}${asset}`, { signal: AbortSignal.timeout(5_000) });
                equal(response.status, 200, asset);
                match(
                    response.headers.get("content-type") || "",
                    asset.endsWith(".css") ? /text\/css/i : /(?:text|application)\/javascript/i,
                );
                deepEqual(
                    new Uint8Array(await response.arrayBuffer()),
                    new Uint8Array(await readFile(join(assetsDirectory, asset))),
                    asset,
                );
            }
            const denied = await fetch(`${base}/api/owner/projects`);
            equal(denied.status, 401);
            await denied.text();
            const invalid = await fetch(`${base}/projects/%/plans`);
            equal(invalid.status, 500);
            equal(await invalid.text(), "Internal Server Error");
            ok(running.child.kill("SIGTERM"), "Workspace process accepts termination");
            const exit = await running.finished;
            // Windows TerminateProcess has no POSIX SIGTERM handler; interactive /quit
            // is qualified separately. Here require actual exit and a closed listener.
            if (platform !== "win32") equal(exit, 0, running.output());
            else {
                ok(running.child.exitCode !== null || running.child.signalCode !== null);
                await fetch(base, { signal: AbortSignal.timeout(2_000) }).then(
                    () => {
                        throw new Error("Workspace listener survived termination");
                    },
                    () => {},
                );
            }
        } finally {
            clearTimeout(watchdog);
            if (running.child.exitCode === null) running.child.kill("SIGKILL");
            await running.finished;
        }
        console.log(
            `Relocated Bun package passed: CLI onboarding/cancel, relocated Project reads and entry, worker/WASM, image conversion, bundled Agents and skills, Workspace assets/auth, shutdown (${metadata.target}).`,
        );
    } finally {
        await removeExecutableFixtureDirectory(home);
    }
}

if (import.meta.main) {
    if (argv.length < 3 || argv.length > 5) {
        throw new Error("Usage: check-bun-package.ts <executable> [expected-assets-directory] [helper-fixture-path]");
    }
    await checkBunPackage(argv[2], argv[3], argv[4]);
}
