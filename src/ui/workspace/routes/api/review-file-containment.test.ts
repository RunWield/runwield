import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { assertEquals } from "../../../../testing/assertions.ts";
import { reviewFileContentApi } from "./review-file-handlers.ts";

const inside = "synthetic inside content\n";
const outside = "synthetic outside-only marker 306\n";

async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), "review-containment-"));
    const cwd = join(dir, "project");
    await mkdir(join(cwd, "slot"), { recursive: true });
    await mkdir(join(dir, "outside"));
    await writeFile(join(cwd, "slot", "data.txt"), inside);
    await writeFile(join(dir, "outside", "data.txt"), outside);
    const outsideMode = (await stat(join(dir, "outside", "data.txt"))).mode;
    return { dir, cwd, outsideMode };
}

async function read(cwd: string) {
    return await reviewFileContentApi(new Request("http://localhost/api/file-content?path=slot/data.txt"), { cwd });
}

test("review working-file read returns inside content", async () => {
    const { dir, cwd } = await fixture();
    try {
        const response = await read(cwd);
        assertEquals(response.status, 200);
        assertEquals((await response.json()).contents, inside);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("review working-file read preserves inside symlinks", async () => {
    const { dir, cwd } = await fixture();
    try {
        await symlink(join(cwd, "slot"), join(cwd, "link"), "junction");
        const response = await reviewFileContentApi(
            new Request("http://localhost/api/file-content?path=link/data.txt"),
            { cwd },
        );
        assertEquals(response.status, 200);
        assertEquals((await response.json()).contents, inside);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("review working-file read rejects a static outside directory symlink", async () => {
    const { dir, cwd } = await fixture();
    try {
        await rm(join(cwd, "slot"), { recursive: true });
        await symlink(join(dir, "outside"), join(cwd, "slot"), "junction");
        assertEquals((await read(cwd)).status, 403);
        assertEquals(await readFile(join(dir, "outside", "data.txt"), "utf8"), outside);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("review working-file read never returns outside content during ancestor replacement", async () => {
    const { dir, cwd, outsideMode } = await fixture();
    const child = spawn(
        process.execPath,
        [
            "--eval",
            `
        const { renameSync, symlinkSync, unlinkSync } = require("node:fs");
        const { join } = require("node:path");
        const dir = process.argv[1];
        const slot = join(dir, "project", "slot");
        const parked = join(dir, "project", "parked");
        console.log("ready");
        const pause = new Int32Array(new SharedArrayBuffer(4));
        for (;;) {
            renameSync(slot, parked);
            symlinkSync(join(dir, "outside"), slot, "junction");
            Atomics.wait(pause, 0, 0, 1);
            unlinkSync(slot);
            renameSync(parked, slot);
            Atomics.wait(pause, 0, 0, 1);
        }
    `,
            dir,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = once(child, "exit");
    try {
        await once(child.stdout!, "data");
        let successes = 0;
        for (let i = 0; i < 20000; i++) {
            assertEquals(child.exitCode, null);
            assertEquals(child.signalCode, null);
            const response = await read(cwd);
            const body = await response.json();
            if (response.status === 200 && body.contents !== undefined) {
                assertEquals(body.contents, inside);
                successes++;
            } else {
                assertEquals([200, 403, 500].includes(response.status), true);
            }
        }
        assertEquals(successes > 0, true, "The race must exercise successful inside reads too.");
        console.log(`ancestor replacement: 20000 reads, ${successes} inside responses`);
        assertEquals(await readFile(join(dir, "outside", "data.txt"), "utf8"), outside);
    } finally {
        child.kill();
        await exited;
        try {
            assertEquals(await readFile(join(dir, "outside", "data.txt"), "utf8"), outside);
            assertEquals((await stat(join(dir, "outside", "data.txt"))).mode, outsideMode);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
});
