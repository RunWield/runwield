import { ok as assert } from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir, readlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import {
    fauxAssistantMessage,
    fauxText,
    fauxToolCall,
    getCurrentTools,
    type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { assertEquals } from "../../testing/assertions.ts";
import { git } from "../workflow/validation-test-helpers.js";
import { type RuntimeFixture, type RuntimeProcess } from "./remote-runtime-test-fixture.ts";
import type { RuntimeClientReport } from "./remote-runtime-test-client.ts";

export const deliveryPlan = `---
planId: remote-delivery-plan
classification: PLANNED_CHANGE
workKind: FEATURE
complexity: LOW
status: draft
summary: Deliver a remote-only sentinel change
executionAgent: engineer
collaborationRecommendation: autonomous
targetBranch: main
affectedPaths:
    - sentinel.txt
---
# Remote delivery

## Context

The remote sentinel must say remote delivered.

## Implementation Steps

- Change sentinel.txt to remote delivered.

## Verification Plan

- Read the remote sentinel and run the fixture verification command.
`;

export async function prepareDelivery(f: RuntimeFixture) {
    await mkdir(join(f.remoteProject, ".wld"), { recursive: true });
    await writeFile(join(f.remoteProject, ".gitignore"), ".wld/\n");
    await writeFile(
        join(f.remoteProject, ".wld/settings.json"),
        JSON.stringify({
            verification_command: `printf 'ci\\n' >> '${join(f.remoteHome, "ci.log")}'`,
            codereview: "none",
        }),
    );
    await git(f.remoteProject, ["add", ".gitignore"]);
    await git(f.remoteProject, ["commit", "-m", "Fixture project settings"]);
    const upstream = join(f.remoteHome, "published.git");
    await git(f.remoteProject, ["init", "--bare", upstream]);
    await git(f.remoteProject, ["remote", "add", "origin", upstream]);
    await git(f.remoteProject, ["push", "-u", "origin", "main"]);
    return upstream;
}

export async function planDelivery(f: RuntimeFixture, client: RuntimeProcess) {
    f.setModelMessages([
        fauxAssistantMessage(fauxToolCall("write", { path: "docs/plans/remote-delivery.md", content: deliveryPlan })),
        fauxAssistantMessage(
            fauxToolCall("plan_written", {
                planName: "remote-delivery",
                executionAgent: "engineer",
                collaborationRecommendation: "autonomous",
            }),
        ),
        fauxAssistantMessage(fauxText("Plan approved for remote execution.")),
    ]);
    await client.send({ kind: "workflow-plan" });
    const ready = await client.read();
    assertEquals(ready.kind, "review-ready", JSON.stringify(ready));
    assert(ready.reviewUrl);
    const page = new URL(ready.reviewUrl);
    const token = page.searchParams.get("token");
    assert(token);
    const response = await fetch(new URL(`/api/review/decision?token=${token}`, page.origin), {
        unix: f.review.socketPath,
        method: "POST",
        headers: { "content-type": "application/json", "x-runwield-review-token": token },
        body: JSON.stringify({
            approved: true,
            approvalAction: "later",
            executionAgent: "engineer",
            collaborationRecommendation: "autonomous",
        }),
    });
    assertEquals(response.status, 200, await response.text());
    const planned = await client.read();
    assertEquals(planned.ok, true, planned.error);
    assertEquals(page.origin, f.review.origin);
    assertEquals(f.browserRequests.at(-1), ready.reviewUrl);
    assert(planned.savedId);
    const plan = await readFile(join(f.remoteProject, "docs/plans/remote-delivery.md"), "utf8");
    assert(plan.includes('status: "ready_for_work"'), (await f.control.list(planned.savedId))[0].contents || "");
    return planned.savedId;
}

export async function executeDelivery(f: RuntimeFixture, client: RuntimeProcess) {
    f.setModelMessages([
        fauxAssistantMessage(fauxToolCall("write", { path: "sentinel.txt", content: "remote implemented\n" })),
        fauxAssistantMessage(fauxToolCall("task_completed", { message: "Implemented the remote change." })),
    ]);
    await client.send({ kind: "workflow-execute" });
    const executed = await readWorkflowResult(client);
    assertEquals(executed.result?.executionComplete, true, JSON.stringify(executed));
    assert(executed.result?.executionContext?.executionCwd);
    return executed.result.executionContext;
}

/** Read-only diff inspection and real terminal tools, never transcript stand-ins. */
export function scriptReviewAndRecord(f: RuntimeFixture, repair = false) {
    let review = 0;
    let boundaryTurns = 0;
    let recordings = 0;
    let checklists = 0;
    const respond: FauxResponseFactory = (context) => {
        const tools = getCurrentTools(context.messages).map((tool) => tool.name);
        if (tools.includes("boundary_scenario"))
            return ++boundaryTurns === 1
                ? fauxAssistantMessage(fauxToolCall("boundary_scenario", {}))
                : fauxAssistantMessage(fauxText("Finished."));
        if (tools.includes("manual_qa_completed")) {
            checklists++;
            return fauxAssistantMessage(
                fauxToolCall("manual_qa_completed", {
                    checklistMarkdown: "Manual verification steps\n- [ ] Read the remote delivered sentinel.",
                }),
            );
        }
        if (tools.includes("work_record_completed")) {
            recordings++;
            return fauxAssistantMessage(
                fauxToolCall("work_record_completed", {
                    title: "Remote delivery",
                    summary: "Published the remote sentinel through the laptop model bridge.",
                }),
            );
        }
        if (!tools.includes("review_complete")) {
            const toolResults = context.messages.filter((message) => message.role === "toolResult");
            if (!toolResults.some((message) => message.toolName === "write"))
                return fauxAssistantMessage(
                    fauxToolCall("write", { path: "sentinel.txt", content: "remote delivered\n" }),
                );
            return fauxAssistantMessage(
                fauxToolCall("task_completed", { message: "R1-1: fixed. sentinel.txt now says remote delivered." }),
            );
        }
        const results = context.messages
            .filter((message) => message.role === "toolResult")
            .filter((message) => message.toolName === "review_diff");
        for (const scope of ["full", "repair"]) {
            const listing = results.find(
                (message) =>
                    JSON.stringify(message.details).includes(`"scope":"${scope}"`) &&
                    (JSON.stringify(message).includes("Changed Files") ||
                        JSON.stringify(message).includes("No repair scope")),
            );
            if (!listing) return fauxAssistantMessage(fauxToolCall("review_diff", { command: "list", scope }));
            const paths = [...JSON.stringify(listing.content).matchAll(/`([^`]+)` \|/g)].map((match) => match[1]);
            const inspected = results
                .filter((message) => JSON.stringify(message.details).includes(`"scope":"${scope}"`))
                .map((message) => JSON.stringify(message));
            const missing = paths.find((path) => !inspected.some((result) => result.includes(`Diff: ${path}`)));
            if (missing)
                return fauxAssistantMessage(fauxToolCall("review_diff", { command: "show", scope, path: missing }));
        }
        review++;
        return fauxAssistantMessage(
            fauxToolCall("review_complete", {
                approved: !repair || review > 1,
                findings: repair
                    ? [
                          {
                              ...(review > 1 ? { id: "R1-1", status: "fix_confirmed" } : {}),
                              title: "The sentinel is not delivered",
                              requirement: "The sentinel must say remote delivered",
                              evidence: "sentinel.txt",
                          },
                      ]
                    : [],
                advisories: [],
            }),
        );
    };
    f.setModelResponseFactories(Array.from({ length: 80 }, () => respond));
    return { reviews: () => review, recordings: () => recordings, checklists: () => checklists };
}

export async function readWorkflowResult(client: RuntimeProcess): Promise<RuntimeClientReport> {
    let report = await client.read();
    while (report.kind === "workflow-interaction") report = await client.read();
    return report;
}

export async function ciRuns(f: RuntimeFixture) {
    return (await readFile(join(f.remoteHome, "ci.log"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
        .length;
}

interface ProjectEntry {
    path: string;
    kind: "directory" | "file" | "symlink";
    bytes?: string;
}

export async function snapshotProjectTree(root: string, excluded: string[] = []): Promise<ProjectEntry[]> {
    const entries: ProjectEntry[] = [];
    async function walk(relative: string) {
        for (const name of (await readdir(join(root, relative))).sort()) {
            const path = relative ? `${relative}/${name}` : name;
            if (excluded.includes(path)) continue;
            const absolute = join(root, path);
            const info = await lstat(absolute);
            if (info.isDirectory()) {
                entries.push({ path, kind: "directory" });
                await walk(path);
            } else if (info.isSymbolicLink()) entries.push({ path, kind: "symlink", bytes: await readlink(absolute) });
            else entries.push({ path, kind: "file", bytes: (await readFile(absolute)).toString("base64") });
        }
    }
    await walk("");
    return entries;
}
