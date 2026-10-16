import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { match as assertMatch, notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { assertEquals } from "../../testing/assertions.ts";
import { bindRemoteMemory, remoteMemoryIdentity } from "./memory-binding.ts";
import type { ResolvedRemoteTarget } from "./target.ts";
import { ensureProject } from "../session/file-session-storage.ts";
import { getRunWieldSessionsBaseDir } from "../session/root-session.js";
import { createMnemotecaTools } from "../../extensions/mnemoteca/tools.ts";
import { denoHelperBinaryExec } from "../../extensions/helper-binary-exec.ts";
import { installMemoryProcessFixture } from "./memory-process-fixture.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

function target(root: string): ResolvedRemoteTarget {
    return {
        host: { hostname: "SCT.example", user: "dev", port: 22, hostKeyFingerprint: "SHA256:one" },
        cwd: `${root}/subfolder`,
        home: "/home/dev",
        os: "Linux",
        arch: "x86_64",
        primaryRoot: root,
        gitRoot: `${root}/worktree`,
        gitDir: `${root}/.git/worktrees/feature`,
        gitCommonDir: `${root}/.git`,
        isWorktree: true,
    };
}

test("remote Memory uses normalized host and primary root, not alias, cwd, or host key", () => {
    const original = target("/home/dev/proj");
    const changed = {
        ...original,
        cwd: "/elsewhere",
        host: { ...original.host, hostname: "sct.example", hostKeyFingerprint: "SHA256:two" },
    };
    assertEquals(remoteMemoryIdentity(original), remoteMemoryIdentity(changed));
    assertMatch(remoteMemoryIdentity(original).collection, /^proj@sct\.example-[a-f0-9]{16}$/);
});

test("remote Memory separates distinct host, user, port, and roots", () => {
    const original = target("/home/dev/proj");
    for (const host of [
        { ...original.host, hostname: "other.example" },
        { ...original.host, user: "other" },
        {
            ...original.host,
            port: 2222,
        },
    ]) {
        assertNotEquals(
            remoteMemoryIdentity(original).collection,
            remoteMemoryIdentity({ ...original, host }).collection,
        );
    }
    assertNotEquals(remoteMemoryIdentity(original).collection, remoteMemoryIdentity(target("/other/proj")).collection);
});

test("remote Memory saves an automatic collection with no local namesake", () =>
    withProcessGlobalTestLock(async () => {
        const remote = target(`/remote/no-local-${crypto.randomUUID()}`);
        const previous = globalThis.prompt;
        globalThis.prompt = () => {
            throw new Error("Unexpected question");
        };
        try {
            assertEquals(await bindRemoteMemory(remote), remoteMemoryIdentity(remote).collection);
            assertEquals(await bindRemoteMemory(remote), remoteMemoryIdentity(remote).collection);
        } finally {
            globalThis.prompt = previous;
        }
    }));

for (const choice of ["0", "1"]) {
    test(`remote Memory remembers the same-project answer ${choice}`, () =>
        withProcessGlobalTestLock(async () => {
            const local = await mkdtemp(join(tmpdir(), "memory-namesake-"));
            ensureProject(getRunWieldSessionsBaseDir(), local);
            const remote = target(`/remote/${basename(local)}`);
            const previous = globalThis.prompt;
            let question = "";
            globalThis.prompt = (message) => {
                question = message || "";
                return choice;
            };
            try {
                const expected = choice === "1" ? basename(local) : remoteMemoryIdentity(remote).collection;
                assertEquals(await bindRemoteMemory(remote), expected);
                assertMatch(question, /Is dev@SCT.example:/);
                assertEquals(question.includes(local), true);
                globalThis.prompt = () => {
                    throw new Error("Asked twice");
                };
                assertEquals(await bindRemoteMemory(remote), expected);
            } finally {
                globalThis.prompt = previous;
                await rm(local, { recursive: true });
            }
        }));
}

test("remote Memory lists each local folder with the same name", () =>
    withProcessGlobalTestLock(async () => {
        const temp = await mkdtemp(join(tmpdir(), "memory-binding-"));
        const folder = `proj-${crypto.randomUUID()}`;
        const roots = [join(temp, "one", folder), join(temp, "two", folder)];
        for (const root of roots) {
            await mkdir(root, { recursive: true });
            ensureProject(getRunWieldSessionsBaseDir(), root);
        }
        const previous = globalThis.prompt;
        let question = "";
        globalThis.prompt = (message) => {
            question = message || "";
            return "2";
        };
        try {
            assertEquals(await bindRemoteMemory(target(`/remote/${folder}`)), folder);
            for (const root of roots) assertEquals(question.includes(root), true);
            assertEquals(question.includes("0. No"), true);
        } finally {
            globalThis.prompt = previous;
            await rm(temp, { recursive: true });
        }
    }));

test("a matching Memory collection without a local Session project does not ask a question", () =>
    withProcessGlobalTestLock(async () => {
        const root = await mkdtemp(join(tmpdir(), "memory-binding-"));
        const remote = target(`/remote/collection-only-${crypto.randomUUID()}`);
        const oldPath = process.env["PATH"] || "";
        const oldPrompt = globalThis.prompt;
        const oldDatabase = process.env["MNEMOTECA_DB_PATH"];
        const bin = await installMemoryProcessFixture(root);
        process.env["PATH"] = `${bin}:${oldPath}`;
        process.env["MNEMOTECA_DB_PATH"] = join(root, "collection-only.json");
        globalThis.prompt = () => {
            throw new Error("A collection is not a local project");
        };
        try {
            const [tool] = createMnemotecaTools({
                cwd: root,
                boundCollection: remoteMemoryIdentity(remote).folder,
                exec: denoHelperBinaryExec,
            });
            await tool.execute(
                "collection-only",
                { action: "store", content: "Unregistered project memory" },
                undefined,
                undefined,
                {} as Parameters<typeof tool.execute>[4],
            );
            assertEquals(await bindRemoteMemory(remote), remoteMemoryIdentity(remote).collection);
        } finally {
            process.env["PATH"] = oldPath;
            globalThis.prompt = oldPrompt;
            if (oldDatabase === undefined) delete process.env["MNEMOTECA_DB_PATH"];
            else process.env["MNEMOTECA_DB_PATH"] = oldDatabase;
            await rm(root, { recursive: true });
        }
    }));
