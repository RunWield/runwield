import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { join } from "@std/path";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { getCwdInitState } from "./init-state.ts";
import { runInitCommand } from "./index.ts";
import type { InteractiveSessionPort } from "../../ui/tui/interactive-session-port.ts";
import type {
    RuntimeInteractionRequest,
    RuntimeInteractionResponse,
} from "../../shared/session/session-runtime-interactions.js";

interface InitUi {
    messages: Array<{ message: string; error?: boolean }>;
    uiAPI: Pick<import("../../ui/tui/types.js").UiAPI, "appendSystemMessage">;
}

const UNEXPECTED_SESSION_PORT: InteractiveSessionPort = {
    startInteractiveSession: () =>
        Promise.reject(new Error("Unexpected interactive session in init confirmation test")),
};

function createUi(): InitUi {
    const messages: Array<{ message: string; error?: boolean }> = [];
    return {
        messages,
        uiAPI: {
            appendSystemMessage: (message, error) => messages.push({ message, error }),
        },
    };
}

async function readJsonFile(path: string) {
    return JSON.parse(await Deno.readTextFile(path)) as { verification_command?: string; codereview?: string };
}

function choose(value: string): RuntimeInteractionResponse {
    return { outcome: "selected", value, valueLabel: value };
}

function text(value: string): RuntimeInteractionResponse {
    return { outcome: "text", value };
}

Deno.test("init confirms and saves verification through the real interaction flow", async () => {
    await withRuntimeCommandFixture(
        "init-verification-confirm-",
        async ({ projectRoot, settingsPath, setModelMessages }) => {
            await Deno.writeTextFile(
                join(projectRoot, "deno.json"),
                JSON.stringify({ tasks: { ci: "deno task test" } }),
            );
            await Deno.mkdir(join(projectRoot, ".wld"));
            await Deno.writeTextFile(join(projectRoot, ".wld", "settings.json"), '{ "codereview": "ask" }\n');
            const originalGlobalSettings = await Deno.readTextFile(settingsPath);
            Deno.chdir(projectRoot);
            setModelMessages([
                fauxAssistantMessage(fauxToolCall("user_interview", {
                    question: {
                        id: "verification_command",
                        type: "multiple_choice",
                        prompt: "Which command should RunWield use to verify this project?",
                        choices: [
                            { value: "deno task ci", label: "deno task ci" },
                            { value: "deno task test", label: "deno task test" },
                            { value: "no_verification", label: "No verification command" },
                        ],
                        default: "deno task ci",
                    },
                })),
                fauxAssistantMessage(fauxToolCall("init_save_verification_command", { command: "deno task ci" })),
                fauxAssistantMessage(fauxToolCall("write", {
                    path: "docs/domain-language.md",
                    content: "# Domain Language\n\n## Fixture\n\nCurrent fixture terminology.\n",
                })),
                fauxAssistantMessage(fauxText("Initialization inspection complete.")),
            ]);
            const runtime = createSessionRuntime();
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            const requests: RuntimeInteractionRequest[] = [];
            runtime.setInteractionAdapter(created.sessionId, {
                supportsInteraction: (typeName) => typeName === "select" || typeName === "text",
                requestInteraction: (request) => {
                    if (request.id === "init-project-files") return choose("yes");
                    requests.push(request);
                    return choose("deno task ci");
                },
            });
            const ui = createUi();

            try {
                await runInitCommand([], {
                    uiAPI: ui.uiAPI,
                    sessionRuntime: runtime,
                    sessionId: created.sessionId,
                    sessionPort: UNEXPECTED_SESSION_PORT,
                });

                assertEquals(requests.length, 1);
                assertStringIncludes(requests[0].prompt, "verify this project");
                assert(requests[0].options?.some((option) => option.value === "deno task ci"));
                assert(requests[0].options?.some((option) => option.label === "No verification command"));
                assertEquals(await readJsonFile(join(projectRoot, ".wld", "settings.json")), {
                    codereview: "ask",
                    verification_command: "deno task ci",
                });
                assertEquals(await Deno.readTextFile(settingsPath), originalGlobalSettings);
                assertEquals((await getCwdInitState())?.initDone, true);
                assertEquals(ui.messages, [{
                    message: "✅ Init complete. docs/domain-language.md has been written.",
                    error: undefined,
                }]);
            } finally {
                runtime.closeSession(created.sessionId);
            }
        },
    );
});

Deno.test("init saves an Other verification command after user free text", async () => {
    await withRuntimeCommandFixture(
        "init-verification-other-",
        async ({ projectRoot, setModelMessages }) => {
            await Deno.writeTextFile(
                join(projectRoot, "package.json"),
                JSON.stringify({ scripts: { test: "vitest" } }),
            );
            Deno.chdir(projectRoot);
            setModelMessages([
                fauxAssistantMessage(fauxToolCall("user_interview", {
                    question: {
                        id: "verification_command",
                        type: "multiple_choice",
                        prompt: "Which command should RunWield use to verify this project?",
                        choices: [
                            { value: "npm test", label: "npm test" },
                            { value: "no_verification", label: "No verification command" },
                        ],
                    },
                })),
                fauxAssistantMessage(fauxToolCall("init_save_verification_command", { command: "pnpm test" })),
                fauxAssistantMessage(fauxToolCall("write", {
                    path: "docs/domain-language.md",
                    content: "# Domain Language\n\n## Fixture\n\nOther command terminology.\n",
                })),
                fauxAssistantMessage(fauxText("Initialization inspection complete.")),
            ]);
            const runtime = createSessionRuntime();
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            const answers = [choose("other"), text("pnpm test")];
            runtime.setInteractionAdapter(created.sessionId, {
                supportsInteraction: (typeName) => typeName === "select" || typeName === "text",
                requestInteraction: (request) =>
                    request.id === "init-project-files" ? choose("yes") : answers.shift() || { outcome: "canceled" },
            });

            try {
                await runInitCommand([], {
                    uiAPI: createUi().uiAPI,
                    sessionRuntime: runtime,
                    sessionId: created.sessionId,
                    sessionPort: UNEXPECTED_SESSION_PORT,
                });

                assertEquals(
                    (await readJsonFile(join(projectRoot, ".wld", "settings.json"))).verification_command,
                    "pnpm test",
                );
                assertEquals((await getCwdInitState())?.initDone, true);
            } finally {
                runtime.closeSession(created.sessionId);
            }
        },
    );
});

Deno.test("init cancellation leaves verification unset and init incomplete", async () => {
    await withRuntimeCommandFixture(
        "init-verification-cancel-",
        async ({ projectRoot, setModelMessages }) => {
            await Deno.writeTextFile(join(projectRoot, "README.md"), "# fixture\n");
            Deno.chdir(projectRoot);
            setModelMessages([
                fauxAssistantMessage(fauxToolCall("user_interview", {
                    question: {
                        id: "verification_command",
                        type: "multiple_choice",
                        prompt: "Which command should RunWield use to verify this project?",
                        choices: [
                            { value: "deno task ci", label: "deno task ci" },
                            { value: "no_verification", label: "No verification command" },
                        ],
                    },
                })),
                fauxAssistantMessage(fauxToolCall("write", {
                    path: "docs/domain-language.md",
                    content: "# Domain Language\n\n## Fixture\n\nCanceled command terminology.\n",
                })),
                fauxAssistantMessage(fauxText("Verification command still needs confirmation.")),
            ]);
            const runtime = createSessionRuntime();
            const created = await runtime.createInteractiveSession({ cwd: projectRoot, mode: "new" });
            runtime.setInteractionAdapter(created.sessionId, {
                supportsInteraction: (typeName) => typeName === "select" || typeName === "text",
                requestInteraction: (request) =>
                    request.id === "init-project-files" ? choose("yes") : { outcome: "canceled" },
            });
            const ui = createUi();

            try {
                await runInitCommand([], {
                    uiAPI: ui.uiAPI,
                    sessionRuntime: runtime,
                    sessionId: created.sessionId,
                    sessionPort: UNEXPECTED_SESSION_PORT,
                });

                await assertRejects(
                    () => Deno.stat(join(projectRoot, ".wld", "settings.json")),
                    Deno.errors.NotFound,
                );
                assertEquals((await getCwdInitState())?.initDone, false);
                assertStringIncludes(ui.messages[0].message, "without saving a confirmed verification command");
                assertEquals(ui.messages[0].error, true);
            } finally {
                runtime.closeSession(created.sessionId);
            }
        },
    );
});

for (const outcome of ["no", "canceled", "unsupported"] as const) {
    Deno.test(`init file consent ${outcome} leaves a fresh project untouched and explains how to retry`, async () => {
        await withRuntimeCommandFixture("init-file-consent-", async ({ projectRoot, setModelResponseFactories }) => {
            const initialized = await new Deno.Command("git", {
                cwd: projectRoot,
                args: ["init", "-b", "main"],
                stdout: "piped",
                stderr: "piped",
            }).output();
            assert(initialized.success);
            await Deno.writeTextFile(join(projectRoot, "README.md"), "Existing project\n");
            Deno.chdir(projectRoot);
            let modelCalls = 0;
            setModelResponseFactories([() => {
                modelCalls++;
                return fauxAssistantMessage(fauxText("Unexpected Init"));
            }]);
            const runtime = createSessionRuntime();
            const sessionId = await runtime.createPromptReadySession({
                cwd: projectRoot,
                deferPersistenceUntilFirstMessage: true,
            });
            const requests: RuntimeInteractionRequest[] = [];
            runtime.setInteractionAdapter(sessionId, {
                supportsInteraction: () => true,
                requestInteraction: (request) => {
                    requests.push(request);
                    return outcome === "no" ? choose("no") : { outcome };
                },
            });
            const ui = createUi();
            try {
                await runInitCommand([], {
                    projectRoot,
                    sessionRuntime: runtime,
                    sessionId,
                    uiAPI: ui.uiAPI,
                    sessionPort: UNEXPECTED_SESSION_PORT,
                });
                assertEquals(requests.length, 1);
                for (const path of [".wld/settings.json", "docs/domain-language.md", ".gitignore"]) {
                    assertStringIncludes(requests[0].prompt, path);
                    await assertRejects(() => Deno.stat(join(projectRoot, path)), Deno.errors.NotFound);
                }
                assertEquals(modelCalls, 0);
                assertEquals(await getCwdInitState(projectRoot), undefined);
                assertStringIncludes(ui.messages[0].message, "Init cannot proceed");
                assertStringIncludes(ui.messages[0].message, "Run /init if you change your mind");
                assertEquals(await Deno.readTextFile(join(projectRoot, "README.md")), "Existing project\n");
            } finally {
                await runtime.closeAllSessionsWhenIdle();
            }
        });
    });
}
