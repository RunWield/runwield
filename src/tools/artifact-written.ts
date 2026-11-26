import { toolRegistry } from "@runwield/tools";
import { readPlanSessionArtifact } from "../plan-store/index.ts";
import { readFile as fsReadFile, realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
/**
 * @module artifact-written
 * Register a durable Markdown artifact with the active umbrella RunWield Session.
 */

import { isAbsolute, relative, resolve, sep as SEPARATOR } from "node:path";
import { type AgentToolResult, defineTool } from "@earendil-works/pi-coding-agent";
import { requestHostedSessionInteraction, type HostedSession } from "@runwield/session-runtime/host";
import type { SessionArtifactReference } from "../shared/session/file-session-store-types.ts";
import { RuntimeInteractionOutcomes, RuntimeInteractionTypes } from "@runwield/session-runtime/interactions";

const artifactWritten = toolRegistry.get("artifact_written");
const { definition } = artifactWritten;

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

function portablePath(path: string): string {
    return path.split(SEPARATOR).join("/");
}

async function resolveArtifact(
    projectRoot: string,
    requestedPath: string,
): Promise<{ relativePath: string; sessionPath: string; markdown: string }> {
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
    return { relativePath, sessionPath: relativePath, markdown: await fsReadFile(absolutePath, "utf8") };
}

export function createArtifactWrittenTool(options: ArtifactWrittenOptions = {}) {
    return defineTool<typeof definition.parameters, ArtifactWrittenDetails>({
        ...definition,

        async execute(_toolCallId, params, signal): Promise<ArtifactWrittenResult> {
            try {
                const hostedSession = options.hostedSession;
                if (!hostedSession) throw new Error("Artifact registration requires an active HostedSession");
                const capability = hostedSession.getManagedOperationCapability?.() || null;
                if (!capability) throw new Error("Artifact registration requires an active managed Session turn");
                capability.assertLive();
                const kind = params.kind;
                const resolved =
                    kind === "plan" || kind === "epic-artifact"
                        ? await readPlanSessionArtifact(hostedSession.cwd, params.path, kind)
                        : await resolveArtifact(hostedSession.cwd, params.path);
                artifactWritten.assertKindPath(kind, resolved.relativePath);
                const title = artifactWritten.resolveTitle(resolved.relativePath, resolved.markdown, params.title);
                const artifact = capability.registerArtifact({
                    kind,
                    path: resolved.sessionPath,
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
                                prompt: `Review ${title}. Send an empty response to accept it, or describe what should change.`,
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
                                content: [
                                    {
                                        type: "text",
                                        text: `The ${kind.toUpperCase()} is registered, but the user requested changes:\n\n${feedback}\n\nRevise the artifact and call artifact_written again.`,
                                    },
                                ],
                                details: { outcome: "feedback", artifact, feedback },
                            };
                        }
                        if (
                            review.outcome === RuntimeInteractionOutcomes.TEXT ||
                            review.outcome === RuntimeInteractionOutcomes.ACCEPTED
                        ) {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Reviewed and kept ${kind} artifact: ${artifact.path}`,
                                    },
                                ],
                                details: { outcome: "reviewed", artifact },
                            };
                        }
                    }
                }
                return {
                    content: [{ type: "text", text: `Registered ${kind} artifact: ${resolved.relativePath}` }],
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
