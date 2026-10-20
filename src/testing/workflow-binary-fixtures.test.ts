import { delimiter } from "node:path";
import { captureForegroundProcess } from "../shared/captured-process.ts";
import { getCwd } from "../constants.js";
import { makeTempFile } from "./temp-file.ts";
import { removeExecutableFixtureDirectory } from "./runtime-executable-fixture.ts";
import { test } from "node:test";
import {
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rm as fsRm,
    stat as fsStat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { assertEquals, assertRejects, assertStringIncludes } from "./assertions.ts";
import { join } from "node:path";
import { createClipboardReader } from "../ui/tui/clipboard.ts";
import { assertWorkflowBinaryCallsSupported, writeWorkflowBinaryFixtures } from "./workflow-binary-fixtures.ts";

test("workflow binary fixtures execute supported external commands and preserve Git", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "workflow-binaries-quote'-"));
    try {
        const bin = await writeWorkflowBinaryFixtures(root);
        const run = (name: string, args: string[]) =>
            captureForegroundProcess(join(bin, name), { args, cwd: getCwd() });
        for (const name of ["mnemoteca", "cymbal", "ketch"]) {
            assertEquals((await run(name, ["--help"])).success, true);
        }
        assertEquals((await run("cymbal", ["index", "."])).success, true);
        assertEquals(
            (await run("cymbal", ["--no-federate", "hook", "nudge", "--format=text", "--", "git diff"])).success,
            true,
        );
        const help = await run("mnemoteca", ["update", "--help"]);
        assertStringIncludes(new TextDecoder().decode(help.stdout), "update <id> --replace-tags");
        assertEquals(
            new TextDecoder().decode((await run("mnemoteca", ["list", "-t", "core", "-f", "plain"])).stdout).trim(),
            "No documents",
        );
        assertEquals(JSON.parse(new TextDecoder().decode((await run("mnemoteca", ["search", "query"])).stdout)), {
            results: [],
        });
        const backup = join(root, "nested backup", "export.jsonl");
        assertEquals((await run("mnemoteca", ["export", "--output", backup])).success, true);
        assertEquals(JSON.parse(await fsReadFile(backup, "utf8")), { type: "mnemoteca-export" });
        const clipboard = createClipboardReader({
            os: "darwin",
            runCommand: (name, args) => run(name, args),
            makeTempFile: (options) => makeTempFile(options),
            remove: (path) => fsRm(path),
        });
        assertEquals(await clipboard.readClipboardImage(), null);
        await assertWorkflowBinaryCallsSupported(root);
        await assertRejects(() => fsStat(join(bin, "git")), Error, "ENOENT");
        await assertRejects(() => fsStat(join(bin, "snip")), Error, "ENOENT");
    } finally {
        await removeExecutableFixtureDirectory(root);
    }
});

test("unsupported binary calls fail even when the caller swallows the exit code", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "workflow-binaries-reject-"));
    try {
        const bin = await writeWorkflowBinaryFixtures(root);
        for (const name of ["mnemoteca", "cymbal", "ketch", "osascript"]) {
            const output = await captureForegroundProcess(join(bin, name), {
                args: ["unexpected-operation"],
                cwd: getCwd(),
            });
            assertEquals(output.code, 64);
            assertStringIncludes(new TextDecoder().decode(output.stderr), `Unsupported ${name}`);
        }
        for (const name of ["cymbal", "ketch"]) {
            const output = await captureForegroundProcess(join(bin, name), {
                args: ["--help", "unexpected-operation"],
                cwd: getCwd(),
            });
            assertEquals(output.code, 64);
            assertStringIncludes(new TextDecoder().decode(output.stderr), `Unsupported ${name}`);
        }
        const error = await assertRejects(() => assertWorkflowBinaryCallsSupported(root), Error);
        for (const name of ["mnemoteca", "cymbal", "ketch", "osascript"]) {
            assertStringIncludes(error.message, `Unsupported ${name}`);
        }
    } finally {
        await removeExecutableFixtureDirectory(root);
    }
});

test("shared executable contents keep command logs and failures isolated", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "workflow-binaries-isolation'-"));
    const first = join(root, "first");
    const second = join(root, "second");
    try {
        const [firstBin, secondBin] = await Promise.all([
            writeWorkflowBinaryFixtures(first),
            writeWorkflowBinaryFixtures(second),
        ]);
        if (process.platform !== "win32") {
            assertEquals(await fsRealpath(join(firstBin, "mnemoteca")), await fsRealpath(join(secondBin, "cymbal")));
        }
        const run = (bin: string, name: string, args: string[]) =>
            captureForegroundProcess(name, {
                args,
                env: { PATH: `${bin}${delimiter}${process.env["PATH"] || ""}` },
                cwd: getCwd(),
            });
        const results = await Promise.all([
            run(firstBin, "mnemoteca", ["unexpected-operation"]),
            run(secondBin, "cymbal", ["index", "."]),
        ]);
        assertEquals(
            results.map((result) => result.code),
            [64, 0],
        );
        await assertRejects(() => assertWorkflowBinaryCallsSupported(first), Error, "Unsupported mnemoteca");
        await assertWorkflowBinaryCallsSupported(second);
        assertEquals(await fsReadFile(join(firstBin, "calls.log"), "utf8"), "mnemoteca\nunexpected-operation\n");
        assertEquals(await fsReadFile(join(secondBin, "calls.log"), "utf8"), "cymbal\nindex\n.\n");
        await removeExecutableFixtureDirectory(first);
        assertEquals((await run(secondBin, "mnemoteca", ["--help"])).code, 0);
        await assertWorkflowBinaryCallsSupported(second);
    } finally {
        await removeExecutableFixtureDirectory(root);
    }
});

test("GitHub unavailability is opt-in and preserves supported-call checks", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "workflow-github-fixture-"));
    try {
        const ordinary = await writeWorkflowBinaryFixtures(join(root, "ordinary"));
        await assertRejects(() => fsStat(join(ordinary, "gh")), Error, "ENOENT");
        const goldenRoot = join(root, "golden");
        const golden = await writeWorkflowBinaryFixtures(goldenRoot, { githubUnavailable: true });
        const output = await captureForegroundProcess(join(golden, "gh"), { args: ["auth", "status"], cwd: getCwd() });
        assertEquals(output.code, 1);
        assertStringIncludes(new TextDecoder().decode(output.stderr), "golden fixture: gh unavailable");
        assertEquals(await fsReadFile(join(golden, "calls.log"), "utf8"), "gh\nauth\nstatus\n");
        await assertWorkflowBinaryCallsSupported(goldenRoot);
    } finally {
        await removeExecutableFixtureDirectory(root);
    }
});
