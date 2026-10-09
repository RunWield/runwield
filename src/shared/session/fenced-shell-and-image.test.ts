import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { openOwnerCoordinationStore } from "../owner-coordination/index.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { createSessionRuntime } from "./session-runtime.ts";
import { getRunWieldSessionDir } from "./root-session.js";

function digestHex(bytes: Uint8Array): Promise<string> {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    return crypto.subtle.digest("SHA-256", buffer).then((digest) =>
        Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")
    );
}

function idFactory(prefix: string): () => string {
    let index = 0;
    return () => `${prefix}-${++index}`;
}

async function createDormantManagedSession(prefix: string) {
    const home = await Deno.makeTempDir({ prefix });
    Deno.env.set("HOME", home);
    const cwd = join(home, "project");
    await Deno.mkdir(cwd, { recursive: true });
    const store = openOwnerCoordinationStore({ dbPath: join(home, "owner.sqlite3") });
    const project = store.registerProject({ root: cwd, idFactory: idFactory("project") });
    const piSessionId = "pi-dormant";
    const sessionDir = getRunWieldSessionDir(cwd);
    await Deno.mkdir(sessionDir, { recursive: true });
    const transcriptPath = join(sessionDir, "2026-01-01T00-00-00-000Z_pi-dormant.jsonl");
    const entries = [
        { type: "session", id: piSessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd, name: "Dormant" },
        {
            type: "message",
            id: "entry-user",
            timestamp: "2026-01-01T00:00:01.000Z",
            message: { role: "user", content: "Hello" },
        },
    ];
    await Deno.writeTextFile(transcriptPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const cataloged = await store.ensureSessionCatalogRecord({
        projectId: project.projectId,
        piSessionId,
        transcriptPath,
        transcriptCwd: cwd,
        source: "catalog",
        idFactory: idFactory("session"),
    });
    let proof = store.acquireSessionActivation({
        runwieldSessionId: cataloged.runwieldSessionId,
        projectId: project.projectId,
        ownerInstanceId: "bootstrap-owner",
        ownerProcessKind: "test",
        phase: "bootstrap",
    });
    proof = store.changeSessionActivationPhase(proof, "checkpointing");
    const bytes = await Deno.readFile(transcriptPath);
    store.publishGenerationAndRelease(proof, {
        generation: 0,
        byteLength: bytes.length,
        terminalEntryId: "entry-user",
        digestHex: await digestHex(bytes),
    });
    const runtime = createSessionRuntime({
        sessionStore: store,
        ownerProcessKind: "test",
        ownerInstanceId: `${prefix}-runtime-owner`,
    });
    const adopted = runtime.adoptManagedSession({ session: cataloged, generation: 0 });
    return { home, cwd, store, runtime, sessionId: adopted.sessionId, cataloged, piSessionId };
}

async function countImageFiles(imageDir: string): Promise<number> {
    try {
        let count = 0;
        for await (const entry of Deno.readDir(imageDir)) {
            if (entry.isFile) count += 1;
        }
        return count;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return 0;
        throw error;
    }
}

Deno.test("blocked managed local shell creates zero Deno.Command processes for both persist modes", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const fixture = await createDormantManagedSession("fenced-shell-blocked-");
        Deno.env.set("HOME", fixture.home);
        const originalCommand = Deno.Command;
        let processCreations = 0;
        class CountingCommand {
            constructor(_command: string | URL, _options?: ConstructorParameters<typeof Deno.Command>[1]) {
                processCreations += 1;
                throw new Error("Deno.Command must not be constructed before activation wins");
            }
        }
        Object.defineProperty(Deno, "Command", { configurable: true, value: CountingCommand });
        const holder = fixture.store.acquireSessionActivation({
            runwieldSessionId: fixture.cataloged.runwieldSessionId,
            projectId: fixture.cataloged.projectId,
            ownerInstanceId: "competing-owner",
            ownerProcessKind: "test",
            expectedGeneration: 0,
            phase: "preparing",
        });
        try {
            for (const persist of [true, false]) {
                const result = await fixture.runtime.runLocalShellCommand(fixture.sessionId, {
                    command: "printf should-not-run",
                    persist,
                });
                assertEquals(result.error, "managed_operation_in_progress");
            }
            assertEquals(processCreations, 0);
        } finally {
            Object.defineProperty(Deno, "Command", { configurable: true, value: originalCommand });
            fixture.store.releaseUnchangedActivation(holder);
            await fixture.runtime.closeAllSessionsWhenIdle();
            fixture.store.close();
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await Deno.remove(fixture.home, { recursive: true });
        }
    });
});

Deno.test("blocked managed image persistence leaves zero files under the Session image directory", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const fixture = await createDormantManagedSession("fenced-image-blocked-");
        Deno.env.set("HOME", fixture.home);
        const holder = fixture.store.acquireSessionActivation({
            runwieldSessionId: fixture.cataloged.runwieldSessionId,
            projectId: fixture.cataloged.projectId,
            ownerInstanceId: "competing-owner",
            ownerProcessKind: "test",
            expectedGeneration: 0,
            phase: "preparing",
        });
        const imageDir = join(getRunWieldSessionDir(fixture.cwd), `${fixture.piSessionId}_images`);
        try {
            const result = await fixture.runtime.persistSessionImage(fixture.sessionId, {
                base64: btoa("img"),
                mimeType: "image/png",
            });
            assertEquals(result.error, "managed_operation_in_progress");
            assertEquals(await countImageFiles(imageDir), 0);
        } finally {
            fixture.store.releaseUnchangedActivation(holder);
            await fixture.runtime.closeAllSessionsWhenIdle();
            fixture.store.close();
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await Deno.remove(fixture.home, { recursive: true });
        }
    });
});
