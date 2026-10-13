import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import { getSlashCommandDefinitions } from "../../../cmd/registry.js";
import { goldenTuiPortfolioScenarios } from "./catalog.ts";

const EXPECTED_SLASH_COMMANDS = [
    "agent",
    "compact",
    "context",
    "copy",
    "exit",
    "export",
    "help",
    "init",
    "load-plan",
    "login",
    "logout",
    "mcp",
    "model",
    "name",
    "new",
    "onboard",
    "plan-review",
    "quit",
    "reload",
    "resume",
    "session",
    "settings",
    "share",
    "sleep",
    "status",
    "theme",
    "version",
] as const;

type OwnedScenario = { name: string; slashCommands?: string[] };

test("every canonical slash command has exactly one Golden scenario owner", () => {
    const registered = getSlashCommandDefinitions().map((definition) => definition.name).sort();
    assertEquals(registered, [...EXPECTED_SLASH_COMMANDS]);

    const owners = new Map<string, string[]>();
    for (const scenario of goldenTuiPortfolioScenarios as OwnedScenario[]) {
        for (const command of scenario.slashCommands || []) {
            owners.set(command, [...(owners.get(command) || []), scenario.name]);
        }
    }

    assertEquals([...owners.keys()].sort(), [...EXPECTED_SLASH_COMMANDS]);
    assertEquals(
        [...owners.entries()].filter(([, scenarioNames]) => scenarioNames.length !== 1),
        [],
    );
});
