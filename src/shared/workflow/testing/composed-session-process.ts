import { ok, equal } from "node:assert/strict";
import { openFileSessionStore } from "../../session/file-session-store.ts";
import { createRootSessionManager, resolveCreatedRootSessionPath } from "../../session/root-session.js";
import { sessionDirForRoot } from "../../session/file-session-storage.ts";
import { captureTranscriptEvidence } from "../../session/session-transcript-projection.js";
import { admitProjectIdentity } from "../../project-identity.ts";
import { createSessionRuntime } from "../../session/session-runtime.ts";
import { loadPlan } from "../../../plan-store/index.ts";

const [command, root, locator] = process.argv.slice(2);
const store = openFileSessionStore();
try {
    if (command === "create") {
        const project = store.ensureRuntimeProject({ root });
        const directory = sessionDirForRoot(store.path, root);
        const manager = await createRootSessionManager("new", root, directory);
        manager.appendMessage({
            role: "user",
            timestamp: Date.now(),
            content: [{ type: "text", text: "Original delivery Session" }],
        });
        const path = await resolveCreatedRootSessionPath(root, manager, directory);
        const session = await store.ensureSessionCatalogRecord({
            projectId: project.projectId,
            piSessionId: manager.getSessionId(),
            transcriptCwd: root,
            transcriptPath: path,
        });
        const proof = store.acquireSessionActivation({
            runwieldSessionId: session.runwieldSessionId,
            projectId: session.projectId,
            ownerInstanceId: "create",
            ownerProcessKind: "test",
            expectedGeneration: null,
            phase: "bootstrap",
        });
        const evidence = await captureTranscriptEvidence({ transcriptPath: path, transcriptCwd: root });
        store.publishGenerationAndRelease(store.changeSessionActivationPhase(proof, "checkpointing"), {
            ...evidence,
            generation: 0,
        });
        const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
        const loaded = await runtime.loadSession({ cwd: root, sessionId: session.piSessionId, sessionPath: path });
        await runtime.rollManagedSessionSegment(loaded.sessionId, {
            kind: "semantic_repair",
            transcriptCwd: locator,
            continuation: { mode: "repair" },
        });
        const plan = await loadPlan(root, "delivery");
        ok(plan?.attrs.planId);
        await runtime.recordPlanAssociation(loaded.sessionId, {
            planId: plan.attrs.planId,
            planName: "delivery",
            purpose: "execution",
        });
        await runtime.closeSession(loaded.sessionId);
        console.log(
            JSON.stringify({
                path: store.getCurrentSessionSegment(session.runwieldSessionId)?.transcriptPath,
                sessionId: session.runwieldSessionId,
                projectId: session.projectId,
            }),
        );
    } else {
        const project = store.ensureRuntimeProject({ root });
        const session = store.findSessionByLocator({ transcriptPath: locator, projectId: project.projectId });
        ok(session, "Saved Session locator must resolve after Project rename");
        if (command === "resume") {
            equal((await admitProjectIdentity(root)).kind, "existing");
            const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
            const loaded = await runtime.loadSession({
                cwd: root,
                sessionId: session.piSessionId,
                sessionPath: locator,
            });
            equal(
                loaded.cwd,
                root,
                JSON.stringify({
                    plan: (await loadPlan(root, "delivery"))?.attrs,
                    associations: store.listSessionPlanAssociations(session.runwieldSessionId),
                    projectRoot: store.requireSessionProjectRoot(session.projectId),
                }),
            );
            ok((await runtime.renameSession(loaded.sessionId, "Continued after delivery")).ok);
            await runtime.closeSession(loaded.sessionId);
            console.log(
                JSON.stringify({
                    sessionId: session.runwieldSessionId,
                    projectId: session.projectId,
                    cwd: loaded.cwd,
                    historicalCwd: store.getCurrentSessionSegment(session.runwieldSessionId)?.transcriptCwd,
                }),
            );
        } else {
            const generation = store.inspectSessionActivation(session.runwieldSessionId).generation?.generation ?? null;
            if (command === "contend") {
                let contention = "";
                try {
                    const proof = store.acquireSessionActivation({
                        runwieldSessionId: session.runwieldSessionId,
                        projectId: session.projectId,
                        ownerInstanceId: "contender",
                        ownerProcessKind: "test",
                        expectedGeneration: generation,
                    });
                    store.releaseUnchangedActivation(proof);
                } catch (error) {
                    if (!(error instanceof Error)) throw error;
                    contention = error.message;
                }
                ok(
                    contention.includes("Session is open in another RunWield surface"),
                    contention || "Second writer acquired",
                );
                console.log(
                    JSON.stringify({ sessionId: session.runwieldSessionId, projectId: session.projectId, contention }),
                );
            } else {
                const proof = store.acquireSessionActivation({
                    runwieldSessionId: session.runwieldSessionId,
                    projectId: session.projectId,
                    ownerInstanceId: "holder",
                    ownerProcessKind: "test",
                    expectedGeneration: generation,
                });
                console.log("held");
                await new Promise<void>((resolve) => {
                    process.stdin.once("data", () => resolve());
                    process.stdin.resume();
                });
                store.releaseUnchangedActivation(proof);
                process.stdin.pause();
            }
        }
    }
} finally {
    store.close();
}
