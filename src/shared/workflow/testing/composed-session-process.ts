import { projects } from "@runwield/projects";
import { ok, equal } from "node:assert/strict";
import { createServer } from "node:http";
import { openFileSessionStore } from "../../session/file-session-store.ts";
import { createSessionRuntime } from "../../session/session-runtime.ts";
import { loadPlan } from "../../../plan-store/index.ts";

const [command, root, locator] = process.argv.slice(2);
const store = openFileSessionStore();
const runtime = createSessionRuntime({ sessionStore: store, ownerProcessKind: "test" });
try {
    if (command === "create") {
        const project = store.ensureRuntimeProject({ root });
        const loaded = await runtime.createInteractiveSession({ cwd: root });
        ok(loaded.sessionManagerId);
        ok(
            (
                await runtime.runLocalShellCommand(loaded.sessionId, {
                    command: "printf 'Original delivery Session'",
                })
            ).ok,
        );
        const session = store.findSessionByLocator({
            projectId: project.projectId,
            piSessionId: loaded.sessionManagerId,
        });
        ok(session);
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
            equal((await projects.checkout.admit(root)).kind, "existing");
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
            const loaded = await runtime.loadSession({
                cwd: root,
                sessionId: session.piSessionId,
                sessionPath: locator,
            });
            if (command === "contend") {
                const result = await runtime.renameSession(loaded.sessionId, "Competing writer");
                ok(!result.ok, "Second writer acquired");
                equal(result.error, "managed_operation_in_progress");
                const contention = result.error;
                console.log(
                    JSON.stringify({ sessionId: session.runwieldSessionId, projectId: session.projectId, contention }),
                );
            } else {
                // Hold a real Runtime operation at an external HTTP boundary until the parent releases it.
                const server = createServer((_request, response) => {
                    process.stdin.once("data", () => response.end("released"));
                    process.stdin.resume();
                    console.log("held");
                });
                await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
                try {
                    const address = server.address();
                    ok(address && typeof address !== "string");
                    const executable = `'${process.execPath.replaceAll("'", "'\\''")}'`;
                    const result = await runtime.runLocalShellCommand(loaded.sessionId, {
                        command: `${executable} -e 'await fetch("http://127.0.0.1:${address.port}")'`,
                    });
                    ok(result.ok, JSON.stringify(result));
                } finally {
                    server.close();
                    process.stdin.pause();
                }
            }
        }
    }
} finally {
    await runtime.closeAllSessions();
    store.close();
}
