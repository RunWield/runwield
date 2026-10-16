import { tmpdir } from "node:os";
import {
    mkdtemp as fsMkdtemp,
    mkdir as fsMkdir,
    realpath as fsRealpath,
    writeFile as fsWriteFile,
    rm as fsRm,
} from "node:fs/promises";
import { join } from "node:path";
import { openFileSessionStore } from "../session/file-session-store.ts";
import { encodeCwdForSessionDir } from "../session/root-session.js";
import { RemoteSessionOwner } from "../session/remote-session-owner.ts";
import { startRemoteControlService } from "./control.ts";
import { type RemoteSessionRequest, sessionDigest } from "./session-protocol.ts";

export const timestamp = "2026-01-01T00:00:00.000Z";

/** Real catalog, acquisition, manifest and native writer lock. */
interface SessionFixtureOptions {
    version?: number;
    legacyContents?: string;
    homeSessions?: boolean;
    committedLegacy?: boolean;
}

export async function makeSessionFixture(options: SessionFixtureOptions = {}) {
    const root = await fsMkdtemp(join(tmpdir(), "remote-session-save-"));
    const project = join(root, "laptop-project");
    const remoteProject = join(root, "remote-project");
    const mount = join(root, "mount");
    const home = join(root, "remote-home");
    for (const path of [project, remoteProject, mount, home]) await fsMkdir(path);
    const cwd = await fsRealpath(project);
    const baseDir = options.homeSessions ? join(home, ".wld", "sessions") : join(root, "sessions");
    const sessionDir = join(baseDir, encodeCwdForSessionDir(cwd));
    await fsMkdir(sessionDir, { recursive: true });
    const piSessionId = crypto.randomUUID();
    const transcriptPath = join(sessionDir, `2026-01-01T00-00-00-000Z_${piSessionId}.jsonl`);
    const initial = `${JSON.stringify({
        type: "session",
        version: options.version ?? 3,
        id: piSessionId,
        timestamp,
        cwd,
    })}\n${options.legacyContents ?? ""}`;
    await fsWriteFile(transcriptPath, initial);
    const store = openFileSessionStore({ baseDir });
    const registered = store.ensureRuntimeProject({ root: cwd });
    const acquired = await store.ensureSessionCatalogRecordAndAcquire({
        locator: {
            projectId: registered.projectId,
            piSessionId,
            transcriptPath,
            transcriptCwd: cwd,
            source: "created",
        },
        activation: { ownerInstanceId: "laptop-test-owner", ownerProcessKind: "test", phase: "preparing" },
    });
    const { session } = acquired;
    let proof = acquired.proof;
    if (options.committedLegacy) {
        proof = store.changeSessionActivationPhase(proof, "hydrated");
        proof = store.changeSessionActivationPhase(proof, "checkpointing");
        store.publishGenerationAndRelease(proof, {
            generation: 0,
            byteLength: new TextEncoder().encode(initial).length,
            digestHex: sessionDigest(initial),
            terminalEntryId: null,
        });
        proof = store.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: session.projectId,
            ownerInstanceId: "legacy-migrator",
            ownerProcessKind: "test",
            phase: "preparing",
            expectedGeneration: 0,
        });
    }
    const owner = new RemoteSessionOwner(store, proof);
    return {
        root,
        cwd,
        remoteProject,
        mount,
        home,
        baseDir,
        transcriptPath,
        initial,
        store,
        session,
        proof,
        owner,
        request(kind: RemoteSessionRequest["kind"], sequence: number, contents = ""): RemoteSessionRequest {
            return { operation: owner.operation, sequence, kind, contents };
        },
        async close() {
            store.close();
            await fsRm(root, { recursive: true });
        },
    };
}

export function customEntry(id = "effect-1", parentId: string | null = null): string {
    // Whitespace is deliberate: acknowledgements must not normalize saved bytes.
    return `${JSON.stringify(
        { type: "custom", id, parentId, timestamp, customType: "runwield.test", data: { effect: "finished" } },
        null,
        0,
    )} \n`;
}

export async function makeControlFixture() {
    const fixture = await makeSessionFixture();
    const identity = { buildId: "a".repeat(64), protocol: 1 };
    const control = startRemoteControlService(identity);
    control.registerSessionOwner(fixture.owner);
    const baseUrl = `http://127.0.0.1:${control.port}`;
    async function post(path: string, body: string, credential = control.credential) {
        return await fetch(`${baseUrl}${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
            body,
        });
    }
    let healthTimer: ReturnType<typeof setInterval> | undefined;
    let healthRequest = Promise.resolve();
    async function ready() {
        const handshake = await post("/handshake", JSON.stringify(identity));
        await handshake.text();
        const readiness = await post("/readiness", "");
        await readiness.text();
        if (healthTimer === undefined) {
            healthTimer = setInterval(() => {
                healthRequest = healthRequest
                    .then(async () => {
                        const response = await post("/health", "");
                        await response.text();
                    })
                    .catch(() => undefined);
            }, 250);
        }
    }
    return {
        ...fixture,
        control,
        baseUrl,
        post,
        ready,
        async close() {
            clearInterval(healthTimer);
            await healthRequest;
            await control.close();
            await fixture.close();
        },
    };
}

export function deferred() {
    let resolve = () => {};
    const promise = new Promise<void>((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
}

export async function within<T>(promise: Promise<T>, timeoutMs = 30_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Test boundary did not complete")), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
