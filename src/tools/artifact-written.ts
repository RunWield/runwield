import { readFile as fsReadFile, realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
/**
 * @module artifact-written
 * Register a durable Markdown artifact with the active umbrella RunWield Session.
 */

import { isAbsolute, relative, resolve, sep as SEPARATOR } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool } from "@earendil-works/pi-coding-agent";
import type { HostedSession } from "../shared/session/hosted-session.js";
import type { SessionArtifactKind, SessionArtifactReference } from "../shared/session/file-session-store-types.ts";
import {
    requestHostedSessionInteraction,
    RuntimeInteractionOutcomes,
    RuntimeInteractionTypes,
} from "../shared/session/session-runtime-interactions.js";

const TOOL_PARAMS = Type.Object({
    path: Type.String({
        minLength: 1,
        description: "Project-relative path to the completed Markdown artifact.",
    }),
    kind: Type.Union([
        Type.Literal("plan"),
        Type.Literal("prd"),
        Type.Literal("adr"),
        Type.Literal("work-record"),
        Type.Literal("epic-artifact"),
        Type.Literal("report"),
    ], { description: "The artifact's durable role in this Session." }),
    title: Type.Optional(Type.String({
        minLength: 1,
        description: "Human-readable title. Omit to use the first Markdown heading or filename.",
    })),
}, { additionalProperties: false });

interface ArtifactWrittenDetails {
    outcome: "registered" | "reviewed" | "feedback" | "rejected";
    artifact?: SessionArtifactReference;
    reason?: string;
    feedback?: string;
}

interface ArtifactWrittenOptions {
    hostedSession?: HostedSession;
    agentName?: string;
}

type ArtifactWrittenResult = AgentToolResult<ArtifactWrittenDetails>;

const REQUIRED_PARENT_BY_KIND: Partial<Record<SessionArtifactKind, string>> = {
    plan: "docs/plans/",
    prd: "docs/prd/",
    adr: "docs/adr/",
    "work-record": "docs/work-records/",
};

function portablePath(path: string): string {
    return path.split(SEPARATOR).join("/");
}

function inferTitle(markdown: string, artifactPath: string): string {
    const heading = markdown.split(/\r?\n/)
        .map((line) => line.match(/^#\s+(.+?)\s*$/)?.[1]?.trim())
        .find(Boolean);
    if (heading) return heading;
    return artifactPath.split("/").at(-1)?.replace(/\.md$/i, "").replaceAll("-", " ") || "Artifact";
}

async function resolveArtifact(
    projectRoot: string,
    requestedPath: string,
): Promise<{ relativePath: string; markdown: string }> {
    if (isAbsolute(requestedPath)) throw new Error("Artifact path must be relative to the Project root");
    const root = await fsRealpath(projectRoot);
    const absolutePath = await fsRealpath(resolve(root, requestedPath));
    const relativePath = portablePath(relative(root, absolutePath));
    if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) {
        throw new Error("Artifact path must remain inside the Project root");
    }
    if (!relativePath.toLowerCase().endsWith(".md")) throw new Error("Session artifacts must be Markdown files");
    const info = await fsStat(absolutePath);
    if (!info.isFile()) throw new Error("Artifact path must identify a file");
    return { relativePath, markdown: await fsReadFile(absolutePath, "utf8") };
}

function assertKindPath(kind: SessionArtifactKind, path: string): void {
    const requiredParent = REQUIRED_PARENT_BY_KIND[kind];
    if (requiredParent && !path.startsWith(requiredParent)) {
        throw new Error(`${kind} artifacts must be stored under ${requiredParent}`);
    }
}

export function createArtifactWrittenTool(options: ArtifactWrittenOptions = {}) {
    return defineTool<typeof TOOL_PARAMS, ArtifactWrittenDetails>({
        name: "artifact_written",
        label: "Artifact Written",
        description: "Register a completed, meaningful Markdown artifact with the current RunWield Session. " +
            "Use this after writing a PRD, ADR, report, Work Record, or other explicit deliverable; do not register files merely mentioned or edited during implementation.",
        parameters: TOOL_PARAMS,
        async execute(_toolCallId, params, signal): Promise<ArtifactWrittenResult> {
            try {
                const hostedSession = options.hostedSession;
                if (!hostedSession) throw new Error("Artifact registration requires an active HostedSession");
                const capability = hostedSession.getManagedOperationCapability?.() || null;
                if (!capability) throw new Error("Artifact registration requires an active managed Session turn");
                capability.assertLive();
                const resolved = await resolveArtifact(hostedSession.cwd, params.path);
                const kind = params.kind as SessionArtifactKind;
                assertKindPath(kind, resolved.relativePath);
                const title = params.title?.trim() || inferTitle(resolved.markdown, resolved.relativePath);
                const artifact = capability.registerArtifact({
                    kind,
                    path: resolved.relativePath,
                    title,
                    registeredBy: options.agentName?.trim() || "agent",
                });
                if (kind === "prd" || kind === "adr") {
                    const choice = await requestHostedSessionInteraction(
                        hostedSession,
                        {
                            type: RuntimeInteractionTypes.SELECT,
                            prompt: `${title} is saved. Would you like to review it now?`,
                            options: [
                                {
                                    value: "review_now",
                                    label: "Review now",
                                    description: "Open the read-only Markdown view and return feedback to the agent.",
                                },
                                {
                                    value: "keep",
                                    label: "Keep without review",
                                    description: "Keep the registered artifact and continue without a review round.",
                                },
                            ],
                            defaultValue: "review_now",
                        },
                        signal,
                        capability,
                    );
                    if (choice.outcome === RuntimeInteractionOutcomes.SELECTED && choice.value === "review_now") {
                        const review = await requestHostedSessionInteraction(
                            hostedSession,
                            {
                                type: RuntimeInteractionTypes.ARTIFACT_REVIEW,
                                prompt:
                                    `Review ${title}. Send an empty response to accept it, or describe what should change.`,
                                placeholder: "Feedback (leave empty to accept)",
                                allowEmpty: true,
                                _meta: {
                                    artifactId: artifact.artifactId,
                                    artifactKind: artifact.kind,
                                    artifactPath: artifact.path,
                                    title: artifact.title,
                                    markdown: resolved.markdown,
                                    cwd: hostedSession.cwd,
                                },
                            },
                            signal,
                            capability,
                        );
                        const feedback = typeof review.value === "string" ? review.value.trim() : "";
                        if (feedback) {
                            return {
                                content: [{
                                    type: "text",
                                    text:
                                        `The ${kind.toUpperCase()} is registered, but the user requested changes:\n\n${feedback}\n\nRevise the artifact and call artifact_written again.`,
                                }],
                                details: { outcome: "feedback", artifact, feedback },
                            };
                        }
                        if (
                            review.outcome === RuntimeInteractionOutcomes.TEXT ||
                            review.outcome === RuntimeInteractionOutcomes.ACCEPTED
                        ) {
                            return {
                                content: [{
                                    type: "text",
                                    text: `Reviewed and kept ${kind} artifact: ${artifact.path}`,
                                }],
                                details: { outcome: "reviewed", artifact },
                            };
                        }
                    }
                }
                return {
                    content: [{ type: "text", text: `Registered ${kind} artifact: ${artifact.path}` }],
                    details: { outcome: "registered", artifact },
                };
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: "text", text: `Artifact was not registered: ${reason}` }],
                    details: { outcome: "rejected", reason },
                };
            }
        },
    });
}
