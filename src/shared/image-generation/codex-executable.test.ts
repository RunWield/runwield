import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../captured-process.ts";
import { test } from "node:test";
import {
    chmod as fsChmod,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import { getCwd, getHomeDir } from "../../constants.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { resolveCodexExecutable } from "./codex-executable.ts";

interface ExecutableFixture {
    root: string;
    pathExecutable: string;
    appExecutable: string;
}

async function withExecutables(run: (fixture: ExecutableFixture) => Promise<void>) {
    await withProcessGlobalTestLock(async () => {
        const home = getHomeDir();
        const priorPath = process.env["PATH"];
        const root = await fsMkdtemp(join(tmpdir(), "runwield-codex-discovery-"));
        const pathExecutable = join(root, "bin", process.platform === "win32" ? "codex.exe" : "codex");
        const appExecutable = join(
            root,
            "Applications",
            "ChatGPT.app",
            "Contents",
            "Resources",
            "codex-cli",
            "CodexCLI.app",
            "Contents",
            "MacOS",
            "codex",
        );
        try {
            await fsMkdir(dirname(pathExecutable), { recursive: true });
            await fsMkdir(dirname(appExecutable), { recursive: true });
            // Discovery must never execute candidates, even when they have executable permissions.
            await fsWriteFile(pathExecutable, "not an executable program", { mode: 0o700 });
            await fsWriteFile(appExecutable, "not an executable program", { mode: 0o700 });
            process.env["HOME"] = root;
            process.env["PATH"] = dirname(pathExecutable);
            await run({ root, pathExecutable, appExecutable });
        } finally {
            process.env["HOME"] = home;
            if (priorPath === undefined) delete process.env["PATH"];
            else process.env["PATH"] = priorPath;
            await fsRm(root, { recursive: true });
        }
    });
}

test("Codex discovery prefers PATH over a desktop app without executing either", () =>
    withExecutables(async (f) => {
        assertEquals(await resolveCodexExecutable(), f.pathExecutable);
    }));

test(
    "Codex discovery uses the home app when PATH is missing, non-executable or a directory",
    {
        skip: process.platform !== "darwin",
    },
    () =>
        withExecutables(async (f) => {
            await fsChmod(f.pathExecutable, 0o600);
            assertEquals(await resolveCodexExecutable(), f.appExecutable);
            await fsRm(f.pathExecutable);
            assertEquals(await resolveCodexExecutable(), f.appExecutable);
            await fsMkdir(f.pathExecutable);
            assertEquals(await resolveCodexExecutable(), f.appExecutable);
            delete process.env["PATH"];
            assertEquals(await resolveCodexExecutable(), f.appExecutable);
        }),
);

test("Codex discovery fails without launching anything when no candidate is accessible", () =>
    withExecutables(async (f) => {
        await fsRm(f.pathExecutable);
        // A clean macOS runner may have no system app. Deny the known home-app
        // fixture as well so permission propagation never depends on host installs.
        if (process.platform !== "darwin") await fsRm(f.appExecutable);
        const homeApplications = join(f.root, "Applications");
        const probe = join(f.root, "probe.ts");
        await fsWriteFile(
            probe,
            `
            import { resolveCodexExecutable } from ${JSON.stringify(
                new URL("./codex-executable.ts", import.meta.url).href,
            )};
            try { console.log(await resolveCodexExecutable()); }
            catch (error) { console.error(error.message); (await import("node:process")).exit(1); }
        `,
        );
        // Hide the real system app via an actual permission boundary. Never inspect credentials or launch a host CLI.
        const useMacSandbox = process.platform === "darwin";
        const command = useMacSandbox ? "/usr/bin/sandbox-exec" : process.execPath;
        const args = runtimeSourceArgs(["run", "-A", probe]);
        const result = await captureForegroundProcess(command, {
            args: useMacSandbox
                ? [
                      "-p",
                      `(version 1)(allow default)(deny file-read* (subpath "/Applications") (subpath ${JSON.stringify(
                          homeApplications,
                      )}))`,
                      process.execPath,
                      ...args,
                  ]
                : args,
            cwd: getCwd(),
        });
        assertEquals(result.code, 1);
        assertEquals(new TextDecoder().decode(result.stdout), "");
        assertStringIncludes(
            new TextDecoder().decode(result.stderr),
            process.platform === "darwin" ? "EPERM" : "Codex executable not found",
        );
    }));
