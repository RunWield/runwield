import { assert, assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { join } from "@std/path";
import { type RuntimeCommandFixture, withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { createInteractiveTuiComposition } from "./interactive-tui-composition.ts";
import { VirtualTerminal } from "./testing/virtual-terminal.js";
import { getTUI } from "./tui.ts";

/** Exercise a hyperlink-capable terminal independently of the developer's terminal. */
async function withDocumentLinkFixture<T>(
    prefix: string,
    run: (fixture: RuntimeCommandFixture) => Promise<T>,
): Promise<T> {
    return await withRuntimeCommandFixture(prefix, async (fixture) => {
        // The runtime fixture already holds the process-global test lock.
        const capabilities = getCapabilities();
        setCapabilities({ ...capabilities, hyperlinks: true });
        try {
            return await run(fixture);
        } finally {
            setCapabilities(capabilities);
        }
    });
}

interface ReaderPayload {
    markdown: string;
    artifactPath: string;
}

interface TranscriptTextBlock {
    type: string;
    text?: string;
}

interface TranscriptMessage {
    role: string;
    content: TranscriptTextBlock[];
}

interface TranscriptEntry {
    message?: TranscriptMessage;
}

function documentUrls(writes: string): string[] {
    // deno-lint-ignore no-control-regex
    const urls = Array.from(writes.matchAll(/\x1b\]8;[^;]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g), (match) => match[1]);
    return [...new Set(urls.filter((url) => new URL(url).pathname === "/review/plan"))];
}

function documentUrl(writes: string, path = "README.md"): string {
    const url = documentUrls(writes).find((url) => new URL(url).searchParams.get("path") === path);
    assert(url, `Expected a rendered OSC 8 document link for ${path}`);
    return url;
}

async function readDocument(url: string): Promise<ReaderPayload> {
    const response = await fetch(url);
    assertEquals(response.status, 200);
    const html = await response.text();
    const payload = html.match(/<script[^>]*data-review-payload[^>]*>([\s\S]*?)<\/script>/);
    assert(payload, "Expected the real document reader payload");
    return JSON.parse(payload[1]);
}

// Startup and replacement hooks are synchronous. Force a public renderer flush
// so terminal output is captured before the hook returns.
function captureCurrentRender(terminal: VirtualTerminal): string {
    const offset = terminal.writes.length;
    getTUI().tui.renderNow(true);
    return terminal.writes.slice(offset);
}

Deno.test("Agent document links serve the Session Project without changing saved transcript text", async () => {
    await withDocumentLinkFixture("document-links-agent-", async ({ projectRoot, setModelResponse }) => {
        Deno.chdir(projectRoot);
        const markdown = "# Project document\nOriginal content.\n";
        await Deno.writeTextFile(join(projectRoot, "README.md"), markdown);
        const output = "Read README.md before continuing.";
        setModelResponse(output);
        const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
        const composition = await createInteractiveTuiComposition("Show the project document.", {
            browser: NO_OPEN_BROWSER_PORT,
            terminal,
            skipModelWelcome: true,
            sessionStartMode: "new",
            initialAgentName: "operator",
        });
        try {
            await composition.waitForIdle();
            await terminal.flush();
            const url = documentUrl(terminal.writes);
            assertEquals(new URL(url).hostname, "127.0.0.1");
            assertEquals((await readDocument(url)).markdown, markdown);
            assertStringIncludes(terminal.getScreenText(), output);
            const exportedPath = join(projectRoot, "transcript.jsonl");
            await composition.runtime.exportSession(composition.sessionId, exportedPath);
            const entries: TranscriptEntry[] = (await Deno.readTextFile(exportedPath)).trim().split("\n").map((line) =>
                JSON.parse(line)
            );
            const assistantText = entries.filter((entry) => entry.message?.role === "assistant")
                .flatMap((entry) => entry.message?.content || [])
                .filter((block) => block.type === "text")
                .map((block) => block.text);
            assertEquals(assistantText, [output]);
        } finally {
            await composition.dispose();
        }
    });
});

for (const role of ["user", "system"] as const) {
    Deno.test(`${role} document mentions remain plain text in the composed TUI`, async () => {
        await withDocumentLinkFixture(`document-links-${role}-`, async ({ projectRoot }) => {
            Deno.chdir(projectRoot);
            await Deno.writeTextFile(join(projectRoot, "README.md"), "# Document\n");
            const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
            const composition = await createInteractiveTuiComposition(null, {
                browser: NO_OPEN_BROWSER_PORT,
                terminal,
                skipModelWelcome: true,
                sessionStartMode: "new",
            });
            try {
                await composition.waitForIdle();
                composition.uiAPI.clearMessages?.();
                const offset = terminal.writes.length;
                const text = "Read README.md before continuing.";
                if (role === "user") composition.uiAPI.appendUserMessage?.(text);
                else composition.uiAPI.appendSystemMessage(text);
                await composition.waitForIdle();
                await terminal.flush();
                assertStringIncludes(terminal.getScreenText(), text);
                assertEquals(documentUrls(terminal.writes.slice(offset)), []);
            } finally {
                await composition.dispose();
            }
        });
    });
}

Deno.test("Session replacement revokes old links and binds the new Project before replacement output", async () => {
    await withDocumentLinkFixture(
        "document-links-replacement-",
        async ({ projectRoot, alternateRoot, setModelResponse }) => {
            Deno.chdir(projectRoot);
            await Deno.writeTextFile(join(projectRoot, "README.md"), "# Original Project\n");
            await Deno.writeTextFile(join(alternateRoot, "README.md"), "# Alternate Project\n");
            await Deno.writeTextFile(join(alternateRoot, "alternate-only.md"), "# Alternate only\n");
            const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
            let replacementOutput = "";
            const composition = await createInteractiveTuiComposition(null, {
                browser: NO_OPEN_BROWSER_PORT,
                terminal,
                skipModelWelcome: true,
                sessionStartMode: "new",
                onSessionReplaced: () => {
                    // Use the same live UiAPI; no replacement host or adapter is supplied.
                    composition.uiAPI.clearMessages?.();
                    composition.uiAPI.appendAgentMessageStart("Engineer").appendText(
                        "Read README.md and alternate-only.md.",
                    );
                    replacementOutput = captureCurrentRender(terminal);
                },
            });
            try {
                await composition.waitForIdle();
                composition.uiAPI.appendAgentMessageStart("Operator").appendText("Read README.md.");
                await composition.waitForIdle();
                await terminal.flush();
                const oldUrl = documentUrl(terminal.writes);
                assertEquals((await readDocument(oldUrl)).markdown, "# Original Project\n");
                await composition.runtime.replaceSessionForExecutionFollowUp(composition.sessionId, {
                    planName: "Document link follow-up",
                    triageMeta: { classification: "FEATURE", complexity: "LOW" },
                    executionAgent: "engineer",
                    executionCwd: alternateRoot,
                });
                const newUrl = documentUrl(replacementOutput);
                assertNotEquals(new URL(newUrl).searchParams.get("token"), new URL(oldUrl).searchParams.get("token"));
                const revoked = await fetch(oldUrl);
                assertEquals(revoked.status, 401);
                await revoked.text();
                assertEquals((await readDocument(newUrl)).markdown, "# Alternate Project\n");
                assertEquals(
                    (await readDocument(documentUrl(replacementOutput, "alternate-only.md"))).markdown,
                    "# Alternate only\n",
                );
                // Subsequent runtime output must also reach the newly attached adapter.
                setModelResponse("After replacement, read README.md.");
                composition.uiAPI.clearMessages?.();
                const offset = terminal.writes.length;
                await composition.runtime.promptSession(composition.sessionId, {
                    initialRequest: "Show the document.",
                });
                await composition.waitForIdle();
                await terminal.flush();
                assertStringIncludes(terminal.getScreenText(), "After replacement, read README.md.");
                const runtimeUrl = documentUrl(terminal.writes.slice(offset));
                assertEquals(runtimeUrl, newUrl);
                assertEquals((await readDocument(runtimeUrl)).markdown, "# Alternate Project\n");
            } finally {
                await composition.dispose();
            }
        },
    );
});

Deno.test("disposing the composed TUI closes its document listener and is safe to repeat", async () => {
    await withDocumentLinkFixture("document-links-dispose-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        await Deno.writeTextFile(join(projectRoot, "README.md"), "# Document\n");
        const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
        const composition = await createInteractiveTuiComposition(null, {
            browser: NO_OPEN_BROWSER_PORT,
            terminal,
            skipModelWelcome: true,
            sessionStartMode: "new",
        });
        try {
            composition.uiAPI.appendAgentMessageStart("Operator").appendText("Read README.md.");
            await composition.waitForIdle();
            await terminal.flush();
            const url = documentUrl(terminal.writes);
            assertEquals((await readDocument(url)).markdown, "# Document\n");
            await composition.dispose();
            await composition.dispose();
            await assertRejects(() => fetch(url), TypeError);
        } finally {
            await composition.dispose();
        }
    });
});

Deno.test("startup failure closes a document listener started by the renderer", async () => {
    await withDocumentLinkFixture("document-links-startup-failure-", async ({ projectRoot }) => {
        Deno.chdir(projectRoot);
        await Deno.writeTextFile(join(projectRoot, "README.md"), "# Document\n");
        const terminal = new VirtualTerminal({ columns: 100, rows: 30 });
        let url = "";
        await assertRejects(
            () =>
                createInteractiveTuiComposition(null, {
                    browser: NO_OPEN_BROWSER_PORT,
                    terminal,
                    skipModelWelcome: true,
                    sessionStartMode: "new",
                    configureUiAPI: (uiAPI) => {
                        assertEquals(terminal.started, true);
                        uiAPI.appendAgentMessageStart("Operator").appendText("Read README.md.");
                        url = documentUrl(captureCurrentRender(terminal));
                        throw new Error("Document fixture startup failure");
                    },
                }),
            Error,
            "Document fixture startup failure",
        );
        assert(url, "The renderer must start a real listener before startup fails");
        await assertRejects(() => fetch(url), TypeError);
        assertEquals(terminal.stopped, true);
    });
});
