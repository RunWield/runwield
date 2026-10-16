import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertRejects } from "../../testing/assertions.ts";
import { join } from "node:path";
import { runRemoteModelProof } from "./model-proof.ts";

test("LIVE proof does not start after its connection closes", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "portable-fixture-"));
    const project = join(root, "project");
    const personal = join(root, "personal");
    await fsMkdir(project);
    await fsMkdir(personal);
    await fsWriteFile(join(project, "sentinel.txt"), "remote-test");
    const controller = new AbortController();
    controller.abort();
    try {
        await assertRejects(
            () =>
                runRemoteModelProof({
                    proof: { provider: "proof-local", modelId: "test", sentinelFile: "sentinel.txt" },
                    mount: { globalRoot: personal, lost: Promise.resolve(), close: () => Promise.resolve() },
                    connection: { port: 1, credential: "a".repeat(64) },
                    cwd: project,
                    signal: controller.signal,
                }),
            DOMException,
            "aborted",
        );
    } finally {
        await fsRm(root, { recursive: true });
    }
});
