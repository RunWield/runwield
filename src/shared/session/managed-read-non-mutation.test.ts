import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { openOwnerCoordinationStore } from "../owner-coordination/index.js";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { createSessionRuntime } from "./session-runtime.ts";
import { SESSION_RUNTIME_METHOD_POLICY } from "./session-runtime-method-policy.ts";
import { getRunWieldSessionDir } from "./root-session.js";

export interface WritablePiCall {
    name: string;
}

export interface TranscriptSnapshot {
    byteLength: number;
    digestHex: string;
    mtimeMs: number;
}

type WritablePiName = "create" | "open" | "list" | "continueRecent" | "migrate";
type WritablePiArgument = string | { id?: string } | undefined;
type WritablePiResult = string | Promise<string> | { getSessionId?: () => string } | { id?: string }[];
type WritablePiFunction = (...args: WritablePiArgument[]) => WritablePiResult;
type WritablePiManager = Partial<Record<WritablePiName, WritablePiFunction>>;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeTempDir(path: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await Deno.remove(path, { recursive: true });
            return;
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) return;
            const isRetryable = error instanceof Error &&
                /Directory not empty|resource busy|os error 66|os error 16/i.test(error.message);
            if (!isRetryable || attempt === 4) throw error;
            await delay(25 * (attempt + 1));
        }
    }
}

export async function sha256File(path: string): Promise<string> {
    const bytes = await Deno.readFile(path);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readTranscriptSnapshot(path: string): Promise<TranscriptSnapshot> {
    const stat = await Deno.stat(path);
    return { byteLength: stat.size, digestHex: await sha256File(path), mtimeMs: stat.mtime?.getTime() ?? 0 };
}

export async function instrumentRealPiWritableApis(): Promise<{ calls: WritablePiCall[]; restore: () => void }> {
    const pi = await import("@earendil-works/pi-coding-agent");
    const manager = pi.SessionManager as WritablePiManager;
    const calls: WritablePiCall[] = [];
    const originals: Partial<Record<WritablePiName, WritablePiFunction>> = {};
    for (const name of ["create", "open", "list", "continueRecent", "migrate"] as WritablePiName[]) {
        const original = manager[name];
        if (typeof original !== "function") continue;
        originals[name] = original;
        manager[name] = ((...args: WritablePiArgument[]) => {
            calls.push({ name });
            return original(...args);
        }) as WritablePiFunction;
    }
    return {
        calls,
        restore: () => {
            for (const name of ["create", "open", "list", "continueRecent", "migrate"] as WritablePiName[]) {
                const original = originals[name];
                if (original) manager[name] = original;
            }
        },
    };
}

export async function assertTranscriptUnchangedDuring(
    transcriptPath: string,
    action: () => Promise<void>,
): Promise<void> {
    const before = await readTranscriptSnapshot(transcriptPath);
    await action();
    const after = await readTranscriptSnapshot(transcriptPath);
    assertEquals(after, before);
}

function idFactory(prefix: string): () => string {
    let index = 0;
    return () => `${prefix}-${++index}`;
}

async function writeManagedTranscript(cwd: string, piSessionId: string): Promise<string> {
    const sessionDir = getRunWieldSessionDir(cwd);
    await Deno.mkdir(sessionDir, { recursive: true });
    const timestamp = "2026-01-01T00:00:00.000Z";
    const transcriptPath = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${piSessionId}.jsonl`);
    const entries = [
        { type: "session", id: piSessionId, timestamp, cwd, name: "Managed dormant" },
        { type: "message", id: "entry-user", timestamp, message: { role: "user", content: "Hello" } },
        {
            type: "message",
            id: "entry-assistant",
            timestamp,
            message: { role: "assistant", content: [{ type: "text", text: "Committed hello." }] },
        },
    ];
    await Deno.writeTextFile(transcriptPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return transcriptPath;
}

Deno.test("managed read sweep drives read paths without writable Pi calls or transcript mutation", async () => {
    await withProcessGlobalTestLock(async () => {
        const previousHome = Deno.env.get("HOME");
        const home = await Deno.makeTempDir({ prefix: "managed-read-non-mutation-" });
        Deno.env.set("HOME", home);
        const cwd = join(home, "project");
        await Deno.mkdir(cwd, { recursive: true });
        const store = openOwnerCoordinationStore({ dbPath: join(home, "owner.sqlite3") });
        const instrumented = await instrumentRealPiWritableApis();
        try {
            const project = store.registerProject({ root: cwd, idFactory: idFactory("project") });
            const piSessionId = "pi-dormant";
            const transcriptPath = await writeManagedTranscript(cwd, piSessionId);
            const session = await store.ensureSessionCatalogRecord({
                projectId: project.projectId,
                piSessionId,
                transcriptPath,
                transcriptCwd: cwd,
                source: "catalog",
                idFactory: idFactory("session"),
            });
            let proof = store.acquireSessionActivation({
                runwieldSessionId: session.runwieldSessionId,
                projectId: project.projectId,
                ownerInstanceId: "managed-read-test",
                ownerProcessKind: "test",
                phase: "bootstrap",
            });
            proof = store.changeSessionActivationPhase(proof, "checkpointing");
            const bytes = await Deno.readFile(transcriptPath);
            const digest = await crypto.subtle.digest("SHA-256", bytes);
            store.publishGenerationAndRelease(proof, {
                generation: 0,
                byteLength: bytes.length,
                terminalEntryId: "entry-assistant",
                digestHex: Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join(
                    "",
                ),
            });
            const runtime = createSessionRuntime({
                sessionStore: store,
                ownerProcessKind: "test",
                ownerInstanceId: "managed-read-test",
            });
            const adopted = runtime.adoptManagedSession({ session, generation: 0 });
            const outputPath = join(home, "export.jsonl");
            const exercised = new Set<string>();
            const run = async (name: string, action: () => void | Promise<void>) => {
                exercised.add(name);
                await assertTranscriptUnchangedDuring(transcriptPath, async () => {
                    await action();
                });
            };
            const promptTemplatePath = join(home, "prompt.md");
            await Deno.writeTextFile(promptTemplatePath, "Hello {{instructions}}");
            await run("expandSessionPromptTemplate", async () => {
                await runtime.expandSessionPromptTemplate(promptTemplatePath, "read");
            });
            await run("expandSessionSkillCommand", async () => {
                try {
                    await runtime.expandSessionSkillCommand(adopted.sessionId, "missing", "");
                } catch {
                    // Missing skills still exercise the runtime read path.
                }
            });
            await run("exportSession", async () => {
                await runtime.exportSession(adopted.sessionId, outputPath);
            });
            await run("getLastAssistantText", async () => {
                assertEquals(await runtime.getLastAssistantText(adopted.sessionId), "Committed hello.");
            });
            await run("getRuntimeActiveAgentName", () => {
                runtime.getRuntimeActiveAgentName(adopted.sessionId);
            });
            await run("getEffectiveAgentName", () => {
                runtime.getEffectiveAgentName(adopted.sessionId);
            });
            await run("getRuntimeActiveExecutionWorkflow", () => {
                runtime.getRuntimeActiveExecutionWorkflow(adopted.sessionId);
            });
            await run("getSessionBackgroundTaskState", () => {
                assertEquals(runtime.getSessionBackgroundTaskState(adopted.sessionId), { active: 0, pending: 0 });
            });
            await run("getSessionContextReport", async () => {
                const report = await runtime.getSessionContextReport(adopted.sessionId);
                assertEquals(report === null, false);
            });
            await run("getSessionInfo", async () => {
                assertEquals((await runtime.getSessionInfo(adopted.sessionId))?.assistantMessages, 1);
            });
            await run("getSessionMemoryBackupDir", () => {
                runtime.getSessionMemoryBackupDir(adopted.sessionId);
            });
            await run("getSessionProjectRoot", () => {
                assertEquals(runtime.getSessionProjectRoot(adopted.sessionId), cwd);
            });
            await run("getSessionSnapshot", () => {
                runtime.getSessionSnapshot(adopted.sessionId);
            });
            await run("getUserTurnSubmissionBlockMessage", () => {
                runtime.getUserTurnSubmissionBlockMessage(adopted.sessionId);
            });
            await run("inspectResumableSession", async () => {
                assertEquals(
                    (await runtime.inspectResumableSession({
                        cwd,
                        sessionId: piSessionId,
                        sessionPath: transcriptPath,
                    })).messageCount,
                    2,
                );
            });
            await run("isManagedSessionDormant", () => {
                runtime.isManagedSessionDormant(adopted.sessionId);
            });
            await run("listPlanAssociatedSessions", async () => {
                await runtime.listPlanAssociatedSessions(cwd, "missing-plan-id");
            });
            await run("verifyPlanAssociatedSession", async () => {
                await runtime.verifyPlanAssociatedSession({
                    runwieldSessionId: session.runwieldSessionId,
                    displayName: session.displayName,
                    archivedAt: session.archivedAt,
                    piSessionId: session.piSessionId,
                    transcriptPath: session.transcriptPath,
                    associations: [],
                    latestPurpose: "planning",
                    currentSegmentKind: "planning",
                    activationState: "idle",
                    activeSurface: null,
                    safePlanningResume: true,
                    reason: null,
                });
            });
            await run("listResumableSessions", async () => {
                await runtime.listResumableSessions(cwd);
            });
            await run("listSessionContextFiles", async () => {
                await runtime.listSessionContextFiles(adopted.sessionId);
            });
            await run("getSessionProjectRoot", () => {
                runtime.getSessionProjectRoot(adopted.sessionId);
            });
            await run("listSessionPromptTemplates", async () => {
                await runtime.listSessionPromptTemplates(adopted.sessionId);
            });
            await run("listSessionSkills", async () => {
                await runtime.listSessionSkills(adopted.sessionId);
            });
            await run("listSessions", () => {
                runtime.listSessions();
            });
            await run("preflightSessionImages", async () => {
                await runtime.preflightSessionImages(adopted.sessionId, []);
            });
            await run("preflightUserTurnImages", async () => {
                await runtime.preflightUserTurnImages(adopted.sessionId, {
                    initialRequest: "hello",
                    initialImages: [],
                });
            });
            await run("requestSessionHelp", () => {
                runtime.requestSessionHelp(adopted.sessionId);
            });
            await run("synchronizeManagedSession", async () => {
                await runtime.synchronizeManagedSession(adopted.sessionId);
            });
            await run("replaySession", async () => {
                await runtime.replaySession(adopted.sessionId);
            });
            const readOnly = Object.entries(SESSION_RUNTIME_METHOD_POLICY)
                .filter(([, policy]) => policy === "read_only")
                .map(([name]) => name);
            assertEquals(readOnly.filter((name) => !exercised.has(name)), []);
            assertEquals(exercised.has("replaySession"), true);
            assertEquals(instrumented.calls, []);
        } finally {
            instrumented.restore();
            store.close();
            if (previousHome === undefined) Deno.env.delete("HOME");
            else Deno.env.set("HOME", previousHome);
            await removeTempDir(home);
        }
    });
});

Deno.test("writable Pi API instrumentation reports a negative control call", async () => {
    const instrumented = await instrumentRealPiWritableApis();
    try {
        const pi = await import("@earendil-works/pi-coding-agent");
        const manager = pi.SessionManager as WritablePiManager;
        try {
            manager.open?.("/missing", "/missing", "/missing");
        } catch {
            // The negative control only proves the writable boundary was reached.
        }
        assertEquals(instrumented.calls.map((call) => call.name), ["open"]);
    } finally {
        instrumented.restore();
    }
});
