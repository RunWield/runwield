import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import { sessionAgentSelection, sessionCommandSuggestions, sessionModelLabel } from "./session-commands.ts";

const options = {
    commands: [
        { name: "agent", description: "Switch Agent", kind: "action" as const },
        { name: "model", description: "Switch model", kind: "action" as const },
        { name: "commit", description: "Commit changes", kind: "prompt" as const },
        { name: "skill:review", description: "Review changes", kind: "prompt" as const },
    ],
    agents: [{ name: "guide", displayName: "Guide" }, { name: "ideator", displayName: "Ideator" }],
    models: [
        { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" },
        { provider: "opencode", id: "gpt-5.6-luna", name: "Luna" },
    ],
    thinkingLevels: ["low", "medium", "high"],
};

test("slash completion offers commands and project macros only for a leading slash", () => {
    assertEquals(sessionCommandSuggestions("/", options).map((item) => item.label), [
        "/agent",
        "/model",
        "/commit",
        "/skill:review",
    ]);
    assertEquals(sessionCommandSuggestions("/mo", options)[0].value, "/model ");
    assertEquals(sessionCommandSuggestions("/skill:r", options)[0].value, "/skill:review ");
    assertEquals(sessionCommandSuggestions("Explain /model", options), []);
    assertEquals(sessionCommandSuggestions("/commit explain the change", options), []);
    assertEquals(sessionCommandSuggestions("/commit\nMore context", options), []);
});

test("slash arguments filter Agents and distinguish identical model names by provider", () => {
    assertEquals(sessionCommandSuggestions("/agent id", options).map((item) => item.value), ["guide", "ideator"]);
    assertEquals(sessionCommandSuggestions("/model luna", options).map((item) => item.label), [
        "openai-codex/gpt-5.6-luna",
        "opencode/gpt-5.6-luna",
    ]);
    assertEquals(sessionCommandSuggestions("/model openai-codex/", options)[0].value, "openai-codex\u001fgpt-5.6-luna");
    assertEquals(sessionModelLabel(options.models[0]), "openai-codex/gpt-5.6-luna");
});

test("Agent defaults supply the displayed selectors without inventing a manual choice", () => {
    assertEquals(
        sessionAgentSelection({
            name: "guide",
            defaults: {
                provider: "openai-codex",
                model: "gpt-5.6-luna",
                thinkingLevel: "low",
            },
        }),
        { provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "low" },
    );
    assertEquals(sessionAgentSelection({ name: "custom" }), { provider: "", model: "", thinkingLevel: "default" });
});
