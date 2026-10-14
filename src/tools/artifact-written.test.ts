import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../testing/assertions.ts";
import { join } from "node:path";
import { HostedSession } from "../shared/session/hosted-session.js";
import type {
    RegisterSessionArtifactOptions,
    SessionArtifactReference,
} from "../shared/session/file-session-store-types.ts";
import { createArtifactWrittenTool } from "./artifact-written.ts";

interface ToolResult {
    content: Array<{ type: string; text: string }>;
    details: { outcome: string; artifact?: SessionArtifactReference; reason?: string; feedback?: string };
    isError?: boolean;
}

async function executeArtifactTool(
    tool: ReturnType<typeof createArtifactWrittenTool>,
    params: { path: string; kind: "prd" | "adr"; title?: string },
): Promise<ToolResult> {
    return await tool.execute(
        "call-1",
        params,
        new AbortController().signal,
        () => {},
        {} as never,
    ) as ToolResult;
}

test("artifact_written registers a canonical Project-relative Markdown reference", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-artifact-written-"));
    try {
        await fsMkdir(join(root, "docs", "prd"), { recursive: true });
        await fsWriteFile(join(root, "docs", "prd", "sidebar.md"), "# Session Sidebar\n\nDetails.\n");
        const registered: RegisterSessionArtifactOptions[] = [];
        const hostedSession = new HostedSession({ id: "artifact-session", cwd: root });
        hostedSession.setManagedOperationCapability({
            runtimeSessionId: "artifact-session",
            runwieldSessionId: "umbrella-session",
            operationId: "operation-1",
            proof: {
                runwieldSessionId: "umbrella-session",
                projectId: "project-1",
                ownerInstanceId: "owner-1",
                ownerProcessKind: "test",
                operationId: "operation-1",
                fence: 1,
                phase: "turning",
                expectedGeneration: 0,
            },
            settled: false,
            assertLive() {},
            updateProof() {},
            settle() {},
            registerArtifact(options) {
                registered.push(options);
                return {
                    artifactId: "artifact-1",
                    kind: options.kind,
                    path: options.path,
                    title: options.title,
                    registeredAt: "2026-01-01T00:00:00.000Z",
                    registeredBy: options.registeredBy,
                    sourceSegmentId: "segment-1",
                };
            },
        });

        const result = await executeArtifactTool(
            createArtifactWrittenTool({ hostedSession, agentName: "Ideator" }),
            { path: "docs/prd/sidebar.md", kind: "prd" },
        );

        assertEquals(result.isError, undefined);
        assertEquals(result.details.outcome, "registered");
        assertEquals(result.details.artifact?.title, "Session Sidebar");
        assertEquals(registered, [{
            kind: "prd",
            path: "docs/prd/sidebar.md",
            title: "Session Sidebar",
            registeredBy: "Ideator",
        }]);
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("artifact_written rejects a kind whose file is outside its canonical directory", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-artifact-written-path-"));
    try {
        await fsWriteFile(join(root, "sidebar.md"), "# Session Sidebar\n");
        const hostedSession = new HostedSession({ id: "artifact-session", cwd: root });
        hostedSession.setManagedOperationCapability({
            runtimeSessionId: "artifact-session",
            runwieldSessionId: "umbrella-session",
            operationId: "operation-1",
            proof: {
                runwieldSessionId: "umbrella-session",
                projectId: "project-1",
                ownerInstanceId: "owner-1",
                ownerProcessKind: "test",
                operationId: "operation-1",
                fence: 1,
                phase: "turning",
                expectedGeneration: 0,
            },
            settled: false,
            assertLive() {},
            updateProof() {},
            settle() {},
            registerArtifact() {
                throw new Error("must not register");
            },
        });

        const result = await executeArtifactTool(
            createArtifactWrittenTool({ hostedSession, agentName: "Ideator" }),
            { path: "sidebar.md", kind: "prd" },
        );

        assertEquals(result.isError, undefined);
        assertEquals(result.details.outcome, "rejected");
        assertStringIncludes(result.details.reason || "", "docs/prd/");
    } finally {
        await fsRm(root, { recursive: true });
    }
});

test("artifact_written offers PRD review and returns feedback for an in-session revision", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "runwield-artifact-review-"));
    try {
        await fsMkdir(join(root, "docs", "prd"), { recursive: true });
        await fsWriteFile(join(root, "docs", "prd", "sidebar.md"), "# Session Sidebar\n");
        const hostedSession = new HostedSession({ id: "artifact-session", cwd: root });
        hostedSession.setManagedMetadata({
            runwieldSessionId: "umbrella-session",
            projectId: "project-1",
            piSessionId: "pi-session",
            transcriptPath: join(root, "session.jsonl"),
            currentSegmentId: "segment-1",
            generation: 0,
            name: "Artifact Session",
            activeAgent: "ideator",
            workflowContext: null,
        });
        const requests: string[] = [];
        hostedSession.setInteractionAdapter({
            supportsInteraction: () => true,
            requestInteraction(request) {
                requests.push(request.type);
                return request.type === "select"
                    ? { outcome: "selected", value: "review_now" }
                    : { outcome: "text", value: "Clarify the empty state." };
            },
        });
        hostedSession.setManagedOperationCapability({
            runtimeSessionId: "artifact-session",
            runwieldSessionId: "umbrella-session",
            operationId: "operation-1",
            proof: {
                runwieldSessionId: "umbrella-session",
                projectId: "project-1",
                ownerInstanceId: "owner-1",
                ownerProcessKind: "test",
                operationId: "operation-1",
                fence: 1,
                phase: "turning",
                expectedGeneration: 0,
            },
            settled: false,
            assertLive() {},
            updateProof() {},
            settle() {},
            registerArtifact(options) {
                return {
                    artifactId: "artifact-1",
                    kind: options.kind,
                    path: options.path,
                    title: options.title,
                    registeredAt: "2026-01-01T00:00:00.000Z",
                    registeredBy: options.registeredBy,
                    sourceSegmentId: "segment-1",
                };
            },
        });

        const result = await executeArtifactTool(
            createArtifactWrittenTool({ hostedSession, agentName: "Ideator" }),
            { path: "docs/prd/sidebar.md", kind: "prd" },
        );

        assertEquals(requests, ["select", "artifact_review"]);
        assertEquals(result.details.outcome, "feedback");
        assertEquals(result.details.feedback, "Clarify the empty state.");
        assertStringIncludes(result.content[0].text, "Revise the artifact");
    } finally {
        await fsRm(root, { recursive: true });
    }
});
