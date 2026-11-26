import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { createInteractiveSessionRuntime as createSessionRuntime } from "@runwield/session-runtime/services";
import { openFileSessionStore } from "../shared/session/file-session-store.ts";
import { readSessionArtifact } from "../shared/session/read-session-artifact.ts";
import { create, documents } from "../shared/testing/plan-package-fixture.ts";
import { openPlanStoreForCheckout, renamePlan } from "../plan-store/index.ts";
import { projects } from "@runwield/projects";
import { plans } from "@runwield/plans";

for (const outcome of ["registered", "feedback", "rejected"] as const) {
    test(`artifact_written ${outcome} uses the real managed turn and durable artifact store`, async () => {
        await withRuntimeCommandFixture(
            `artifact-written-${outcome}-`,
            async ({ projectRoot, setModelResponseFactories }) => {
                const path = outcome === "rejected" ? "sidebar.md" : "docs/prd/sidebar.md";
                const markdown = "# Session Sidebar\n\nDetails owned by the project.\n";
                await mkdir(join(projectRoot, "docs/prd"), { recursive: true });
                await writeFile(join(projectRoot, path), markdown);
                const runtime = createSessionRuntime();
                const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "ideator" });
                const interactions: string[] = [];
                let output = "";
                let observedOutcome = "";
                let modelContinuation = "";
                runtime.subscribeSessionEvents(sessionId, (event) => {
                    if (event.type === "tool_end" && event.toolName === "artifact_written") {
                        output = event.output;
                        const details = event.details;
                        observedOutcome = details && "outcome" in details ? String(details.outcome) : "";
                    }
                });
                runtime.setInteractionAdapter(sessionId, {
                    supportsInteraction: () => true,
                    requestInteraction: (request) => {
                        interactions.push(request.type);
                        if (request.type === "select")
                            return { outcome: "selected", value: outcome === "feedback" ? "review_now" : "keep" };
                        assertEquals(request._meta?.artifactPath, "docs/prd/sidebar.md");
                        assertEquals(request._meta?.markdown, markdown);
                        return { outcome: "text", value: "Clarify the empty state." };
                    },
                });
                setModelResponseFactories([
                    () => fauxAssistantMessage(fauxToolCall("artifact_written", { path, kind: "prd" })),
                    (context) => {
                        modelContinuation = JSON.stringify(context.messages);
                        return fauxAssistantMessage(fauxText("Artifact result received."));
                    },
                ]);
                let durableId = "";
                try {
                    assertEquals(
                        (await runtime.promptUserTurn(sessionId, { initialRequest: "Register the completed PRD." })).ok,
                        true,
                    );
                    assertEquals(observedOutcome, outcome);
                    durableId = runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId || "";
                    if (outcome === "feedback") {
                        assertEquals(interactions, ["select", "artifact_review"]);
                        assertStringIncludes(output, "Revise the artifact");
                        assertStringIncludes(modelContinuation, "Clarify the empty state.");
                    } else if (outcome === "rejected") {
                        assertEquals(interactions, []);
                        assertStringIncludes(output, "docs/prd/");
                    } else {
                        assertEquals(interactions, ["select"]);
                        assertStringIncludes(output, "docs/prd/sidebar.md");
                    }
                    assertEquals(await readFile(join(projectRoot, path), "utf8"), markdown);
                } finally {
                    await runtime.closeAllSessionsWhenIdle();
                }
                const reopened = openFileSessionStore();
                try {
                    const artifacts = reopened.listSessionArtifacts(durableId);
                    assertEquals(
                        artifacts.map((artifact) => ({
                            kind: artifact.kind,
                            path: artifact.path,
                            title: artifact.title,
                        })),
                        outcome === "rejected"
                            ? []
                            : [{ kind: "prd", path: "docs/prd/sidebar.md", title: "Session Sidebar" }],
                    );
                } finally {
                    reopened.close();
                }
            },
        );
    });
}

test("artifact_written saves Plan and Epic references that survive rename, name reuse, and archive", async () => {
    await withRuntimeCommandFixture("artifact-written-owned-", async ({ projectRoot, setModelResponseFactories }) => {
        const admitted = await projects.checkout.admit(projectRoot);
        if (admitted.kind !== "existing") throw new Error("Project admission failed.");
        const definition = { classification: "PROJECT", status: "draft" } as const;
        await create(admitted.identity, {
            planId: "release%20notes",
            name: "release",
            definition,
            documents: {
                ...documents,
                "context.md": "# Original Plan\n",
                "integration-report.md": "# Original report\n",
            },
        });
        const runtime = createSessionRuntime();
        const sessionId = await runtime.createPromptReadySession({ cwd: projectRoot, agentName: "ideator" });
        const paths: string[] = [];
        runtime.subscribeSessionEvents(sessionId, (event) => {
            if (event.type === "tool_end" && event.toolName === "artifact_written") paths.push(event.output);
        });
        setModelResponseFactories([
            () =>
                fauxAssistantMessage(fauxToolCall("artifact_written", { path: "docs/plans/release.md", kind: "plan" })),
            () =>
                fauxAssistantMessage(
                    fauxToolCall("artifact_written", {
                        path: "docs/plans/release/integration-report.md",
                        kind: "epic-artifact",
                    }),
                ),
            () => fauxAssistantMessage(fauxText("Artifacts registered.")),
        ]);
        let durableId = "";
        try {
            assertEquals(
                (await runtime.promptUserTurn(sessionId, { initialRequest: "Register both artifacts." })).ok,
                true,
            );
            durableId = runtime.getSessionSnapshot(sessionId)?.managed?.runwieldSessionId || "";
            assertStringIncludes(paths[0], "Registered plan artifact: docs/plans/release.md");
            assertStringIncludes(
                paths[1],
                "Registered epic-artifact artifact: docs/plans/release/integration-report.md",
            );
        } finally {
            await runtime.closeAllSessionsWhenIdle();
        }

        const store = openPlanStoreForCheckout(projectRoot)!;
        const original = await store.read(plans.identity.parse("release%20notes")!);
        await renamePlan(projectRoot, original.planId, "original-release", original.revision);
        await create(admitted.identity, {
            planId: "release notes",
            name: "release",
            definition,
            documents: {
                ...documents,
                "context.md": "# Replacement Plan\n",
                "integration-report.md": "# Replacement report\n",
            },
        });
        const reopened = openFileSessionStore();
        try {
            const [plan, epic] = reopened.listSessionArtifacts(durableId);
            assertEquals(plan.path, "plans/release%2520notes/context.md");
            assertEquals(epic.path, "plans/release%2520notes/integration-report.md");
            assertEquals((await readSessionArtifact(projectRoot, plan)).markdown, "# Original Plan\n");
            assertEquals((await readSessionArtifact(projectRoot, epic)).markdown, "# Original report\n");
            assertEquals(
                (
                    await readSessionArtifact(projectRoot, {
                        ...epic,
                        path: "plans/release%20notes/integration-report.md",
                    })
                ).markdown,
                "# Replacement report\n",
            );
            const renamed = await store.read(original.planId);
            await store.archive(renamed.planId, { expectedRevision: renamed.revision, force: true });
            assertEquals((await readSessionArtifact(projectRoot, plan)).markdown, "# Original Plan\n");
            assertEquals((await readSessionArtifact(projectRoot, epic)).markdown, "# Original report\n");
        } finally {
            reopened.close();
        }
    });
});
