import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { basename, join } from "@std/path";
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

Deno.test("remote Memory uses normalized host and primary root, not alias, cwd, or host key", () => {
    const original = target("/home/dev/proj");
    const changed = {
        ...original,
        cwd: "/elsewhere",
        host: { ...original.host, hostname: "sct.example", hostKeyFingerprint: "SHA256:two" },
    };
    assertEquals(remoteMemoryIdentity(original), remoteMemoryIdentity(changed));
    assertMatch(remoteMemoryIdentity(original).collection, /^proj@sct\.example-[a-f0-9]{16}$/);
});

Deno.test("remote Memory separates distinct host, user, port, and roots", () => {
    const original = target("/home/dev/proj");
    for (
        const host of [{ ...original.host, hostname: "other.example" }, { ...original.host, user: "other" }, {
            ...original.host,
            port: 2222,
        }]
    ) {
        assertNotEquals(
            remoteMemoryIdentity(original).collection,
            remoteMemoryIdentity({ ...original, host }).collection,
        );
    }
    assertNotEquals(remoteMemoryIdentity(original).collection, remoteMemoryIdentity(target("/other/proj")).collection);
});

Deno.test("remote Memory saves an automatic collection with no local namesake", () =>
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
    Deno.test(`remote Memory remembers the same-project answer ${choice}`, () =>
        withProcessGlobalTestLock(async () => {
            const local = await Deno.makeTempDir({ prefix: "memory-namesake-" });
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
                await Deno.remove(local, { recursive: true });
            }
        }));
}

Deno.test("remote Memory lists each local folder with the same name", () =>
    withProcessGlobalTestLock(async () => {
        const temp = await Deno.makeTempDir();
        const folder = `proj-${crypto.randomUUID()}`;
        const roots = [join(temp, "one", folder), join(temp, "two", folder)];
        for (const root of roots) {
            await Deno.mkdir(root, { recursive: true });
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
            await Deno.remove(temp, { recursive: true });
        }
    }));

Deno.test("a matching Memory collection without a local Session project does not ask a question", () =>
    withProcessGlobalTestLock(async () => {
        const root = await Deno.makeTempDir();
        const remote = target(`/remote/collection-only-${crypto.randomUUID()}`);
        const oldPath = Deno.env.get("PATH") || "";
        const oldPrompt = globalThis.prompt;
        const oldDatabase = Deno.env.get("MNEMOTECA_DB_PATH");
        const bin = await installMemoryProcessFixture(root);
        Deno.env.set("PATH", `${bin}:${oldPath}`);
        Deno.env.set("MNEMOTECA_DB_PATH", join(root, "collection-only.json"));
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
            Deno.env.set("PATH", oldPath);
            globalThis.prompt = oldPrompt;
            if (oldDatabase === undefined) Deno.env.delete("MNEMOTECA_DB_PATH");
            else Deno.env.set("MNEMOTECA_DB_PATH", oldDatabase);
            await Deno.remove(root, { recursive: true });
        }
    }));
