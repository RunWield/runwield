import { rejects } from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createBundledAssetDirectory } from "@runwield/bundled-assets";
import { loadBarePromptDefinition } from "./isolated.ts";
import { BUNDLED_DEFINITIONS_DIR } from "./locations.ts";
import { AGENTS, SUBAGENTS } from "./role-ids.ts";
import { createRoleRegistry } from "./roles.ts";

test("a bare prompt must declare its tool ceiling or explicitly opt out of tool access", async () => {
    const assets = createBundledAssetDirectory(BUNDLED_DEFINITIONS_DIR);

    await rejects(
        () =>
            loadBarePromptDefinition(
                assets,
                createRoleRegistry(),
                {
                    id: SUBAGENTS.REVIEWER,
                    agentName: AGENTS.REVIEWER,
                    displayNameFallback: "Reviewer",
                    loadMode: "barePrompt",
                    file: "reviewer-prompt.md",
                },
                join("subagent-definitions", "reviewer-prompt.md"),
            ),
        /Subagent definition "reviewer" \(barePrompt\) declares neither allowedTools nor toolFree/,
    );
});
