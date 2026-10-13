import { assertEquals } from "../testing/assertions.ts";
import process from "node:process";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withProcessGlobalTestLock } from "../testing/process-global-lock.ts";
import { findWindowsBashPath } from "./windows-bash.ts";

test("Windows Bash discovery finds per-user and custom Git installs without Bash on PATH", async () => {
    await withProcessGlobalTestLock(async () => {
        const keys = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "PATH"];
        const previous = keys.map((key) => process.env[key]);
        const root = await fsMkdtemp(join(tmpdir(), "rw-windows-bash-"));
        const install = async (path: string) => {
            await fsMkdir(dirname(path), { recursive: true });
            await fsWriteFile(path, "fixture executable");
        };
        try {
            for (const key of keys) delete process.env[key];
            assertEquals(findWindowsBashPath(), undefined);
            const local = join(root, "User Profile", "AppData", "Local");
            process.env["LOCALAPPDATA"] = local;
            const userBash = join(local, "Programs", "Git", "bin", "bash.exe");
            await install(userBash);
            assertEquals(findWindowsBashPath(), userBash);

            const system = join(root, "Program Files");
            process.env["ProgramFiles"] = system;
            const systemBash = join(system, "Git", "bin", "bash.exe");
            await install(systemBash);
            assertEquals(findWindowsBashPath(), systemBash);
            await fsRm(systemBash);
            await fsRm(userBash);

            const custom = join(root, "Custom Git");
            await install(join(custom, "cmd", "git.exe"));
            const customBash = join(custom, "bin", "bash.exe");
            await install(customBash);
            process.env["PATH"] = `;"${join(custom, "cmd")}";;`;
            assertEquals(findWindowsBashPath(), customBash);
            await fsRm(customBash);
            const portableBash = join(custom, "usr", "bin", "bash.exe");
            await install(portableBash);
            assertEquals(findWindowsBashPath(), portableBash);

            const standalone = join(root, "MSYS2", "bin");
            const standaloneBash = join(standalone, "bash.exe");
            await install(standaloneBash);
            process.env["PATH"] = `${join(root, "missing")};${standalone}`;
            assertEquals(findWindowsBashPath(), standaloneBash);
            await fsRm(standaloneBash);
            await fsMkdir(standaloneBash);
            assertEquals(findWindowsBashPath(), undefined);
        } finally {
            keys.forEach((key, index) => {
                const value = previous[index];
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            });
            await fsRm(root, { recursive: true });
        }
    });
});
