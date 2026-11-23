import { rejects } from "node:assert/strict";
import { test } from "node:test";
import { createBundledAgentDefinitions } from "./isolated.ts";
import { AGENTS, SUBAGENTS } from "./role-ids.ts";

test("a bare prompt must declare its tool ceiling or explicitly opt out of tool access", async () => {
    const definitions = createBundledAgentDefinitions();

    await rejects(
        () =>
            definitions.loadBarePromptDefinition({
                id: SUBAGENTS.REVIEWER,
                agentName: AGENTS.REVIEWER,
                displayNameFallback: "Reviewer",
                loadMode: "barePrompt",
                file: "reviewer-prompt.md",
            }),
        /Subagent definition "reviewer" \(barePrompt\) declares neither allowedTools nor toolFree/,
    );
});
