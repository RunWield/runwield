import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "@std/path";
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
        const priorPath = Deno.env.get("PATH");
        const root = await Deno.makeTempDir({ prefix: "runwield-codex-discovery-" });
        const pathExecutable = join(root, "bin", Deno.build.os === "windows" ? "codex.exe" : "codex");
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
            await Deno.mkdir(dirname(pathExecutable), { recursive: true });
            await Deno.mkdir(dirname(appExecutable), { recursive: true });
            // Discovery must never execute candidates, even when they have executable permissions.
            await Deno.writeTextFile(pathExecutable, "not an executable program", { mode: 0o700 });
            await Deno.writeTextFile(appExecutable, "not an executable program", { mode: 0o700 });
            Deno.env.set("HOME", root);
            Deno.env.set("PATH", dirname(pathExecutable));
            await run({ root, pathExecutable, appExecutable });
        } finally {
            Deno.env.set("HOME", home);
            if (priorPath === undefined) Deno.env.delete("PATH");
            else Deno.env.set("PATH", priorPath);
            await Deno.remove(root, { recursive: true });
        }
    });
}

Deno.test("Codex discovery prefers PATH over a desktop app without executing either", () =>
    withExecutables(async (f) => {
        assertEquals(await resolveCodexExecutable(), f.pathExecutable);
    }));

Deno.test({
    name: "Codex discovery uses the home app when PATH is missing, non-executable or a directory",
    ignore: Deno.build.os !== "darwin",
    fn: () =>
        withExecutables(async (f) => {
            await Deno.chmod(f.pathExecutable, 0o600);
            assertEquals(await resolveCodexExecutable(), f.appExecutable);
            await Deno.remove(f.pathExecutable);
            assertEquals(await resolveCodexExecutable(), f.appExecutable);
            await Deno.mkdir(f.pathExecutable);
            assertEquals(await resolveCodexExecutable(), f.appExecutable);
            Deno.env.delete("PATH");
            assertEquals(await resolveCodexExecutable(), f.appExecutable);
        }),
});

Deno.test("Codex discovery fails without launching anything when no candidate is accessible", () =>
    withExecutables(async (f) => {
        await Deno.remove(f.pathExecutable);
        await Deno.remove(f.appExecutable);
        const probe = join(f.root, "probe.ts");
        await Deno.writeTextFile(
            probe,
            `
            import { resolveCodexExecutable } from ${
                JSON.stringify(new URL("./codex-executable.ts", import.meta.url).href)
            };
            try { console.log(await resolveCodexExecutable()); }
            catch (error) { console.error(error.message); Deno.exit(1); }
        `,
        );
        // Hide the real system app via an actual permission boundary. Never inspect credentials or launch a host CLI.
        const result = await new Deno.Command(Deno.execPath(), {
            args: [
                "run",
                "--config",
                join(getCwd(), "deno.json"),
                "--no-prompt",
                "--allow-env",
                "--allow-read",
                "--deny-read=/Applications",
                probe,
            ],
            stdout: "piped",
            stderr: "piped",
        }).output();
        assertEquals(result.code, 1);
        assertEquals(new TextDecoder().decode(result.stdout), "");
        assertStringIncludes(
            new TextDecoder().decode(result.stderr),
            Deno.build.os === "darwin" ? "Requires read access" : "Codex executable not found",
        );
    }));
