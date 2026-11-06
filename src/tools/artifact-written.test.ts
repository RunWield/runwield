import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../cmd/testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../shared/session/session-runtime.ts";
import { openFileSessionStore } from "../shared/session/file-session-store.ts";

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
                        observedOutcome = String(event.details?.outcome || "");
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
