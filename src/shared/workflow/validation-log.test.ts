import { test } from "node:test";
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { resolveProjectRuntimeLayout } from "@runwield/project-runtime/layout";
import { openValidationLog, formatValidationOutput } from "./validation-log.ts";

test("opening a validation log keeps the newest 19 logs and non-log files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "validation-log-retention-"));
    try {
        const dir = resolveProjectRuntimeLayout(cwd).selected.validationLogsDir;
        await mkdir(dir, { recursive: true });
        const names = Array.from({ length: 25 }, (_, i) => `old-${String(24 - i).padStart(2, "0")}.log`);
        for (const [index, name] of names.entries()) {
            const path = join(dir, name);
            await writeFile(path, name);
            const date = new Date(1_000_000 + index * 1000);
            await utimes(path, date, date);
        }
        await writeFile(join(dir, "keep.txt"), "keep");
        const log = await openValidationLog(cwd);
        await log.close();
        assertEquals(log.failureReason, null);
        const files = await readdir(dir);
        assertEquals(
            files.filter((name) => name.endsWith(".log")).sort(),
            [...names.slice(6), basename(log.path)].sort(),
        );
        assertEquals(await readFile(join(dir, "keep.txt"), "utf8"), "keep");
    } finally {
        await rm(cwd, { recursive: true });
    }
});

test("concurrent validation log appends save every byte in arrival order before close", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "validation-log-append-"));
    try {
        const log = await openValidationLog(cwd);
        const chunks = ["first\n", "second\n", "last\n"];
        const writes = chunks.map((chunk) => log.append(new TextEncoder().encode(chunk)));
        await log.close();
        await Promise.all(writes);
        assertEquals(log.failureReason, null);
        assertEquals(await readFile(log.path, "utf8"), chunks.join(""));
    } finally {
        await rm(cwd, { recursive: true });
    }
});

test("a failed validation log append is reported without throwing or changing the tail", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "validation-log-write-failure-"));
    try {
        const log = await openValidationLog(cwd);
        await log.close();
        await log.append(new TextEncoder().encode("cannot write to closed file"));
        assertEquals(typeof log.failureReason, "string");
        await log.append(new TextEncoder().encode("later output"));
        const output = formatValidationOutput({ text: "command output", truncated: false, totalBytes: 14 }, log);
        assertStringIncludes(output, "command output");
        assertStringIncludes(output, "Full validation output could not be saved:");
        assertEquals(output.includes("Full validation output saved to"), false);
    } finally {
        await rm(cwd, { recursive: true });
    }
});
