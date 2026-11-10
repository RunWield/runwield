import { getCwd } from "../../constants.ts";
import process from "node:process";
import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { savePlan } from "../../plan-store.js";
import { type BrowserPort, NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { runPlansUiCommand } from "./ui.ts";

interface CapturedConsole {
    errors: string[];
    logs: string[];
    warnings: string[];
}

async function withPlansUiFixture(run: (projectRoot: string) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousCwd = getCwd();
        const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-plans-ui-"));
        try {
            await savePlan(
                projectRoot,
                "workspace-fixture",
                "# Workspace Fixture Plan\n\n## Context\n\nVisible through the real Workspace server\n",
                {
                    planId: "workspace-fixture-id",
                    classification: "PLANNED_CHANGE",
                    complexity: "LOW",
                    summary: "Visible through the real Workspace server",
                    affectedPaths: [],
                    status: "draft",
                },
            );
            process.chdir(projectRoot);
            await run(projectRoot);
        } finally {
            process.chdir(previousCwd);
            await fsRm(projectRoot, { recursive: true });
        }
    });
}

async function captureConsole(run: () => Promise<void>): Promise<CapturedConsole> {
    const originalError = console.error;
    const originalLog = console.log;
    const originalWarn = console.warn;
    const captured: CapturedConsole = { errors: [], logs: [], warnings: [] };
    console.error = (message = "") => captured.errors.push(String(message));
    console.log = (message = "") => captured.logs.push(String(message));
    console.warn = (message = "") => captured.warnings.push(String(message));
    try {
        await run();
    } finally {
        console.error = originalError;
        console.log = originalLog;
        console.warn = originalWarn;
    }
    return captured;
}

for (const args of [[], ["--host", "localhost"], ["--bind", "::1"]]) {
    test(`plans ui serves authenticated Plans using ${args.at(-1) || "default loopback"}`, async () => {
        await withPlansUiFixture(async () => {
            const controller = new AbortController();
            let openedUrl = "";
            const browser: BrowserPort = {
                async open(url: string): Promise<boolean> {
                    openedUrl = url;
                    const workspaceUrl = new URL(url);
                    const apiUrl = new URL("/api/plans", workspaceUrl.origin);

                    const unauthorized = await fetch(apiUrl);
                    assertEquals(unauthorized.status, 401);

                    apiUrl.search = workspaceUrl.search;
                    const response = await fetch(apiUrl);
                    assertEquals(response.status, 200);
                    const responseBody = await response.text();
                    assertStringIncludes(responseBody, '"planId":"workspace-fixture-id"');
                    assertStringIncludes(responseBody, "Visible through the real Workspace server");
                    controller.abort();
                    return true;
                },
            };

            const captured = await captureConsole(() =>
                runPlansUiCommand(args, { browser, signal: controller.signal }),
            );

            assertStringIncludes(
                openedUrl,
                args.includes("::1")
                    ? "http://[::1]:"
                    : args.includes("localhost")
                      ? "http://localhost:"
                      : "http://127.0.0.1:",
            );
            assertStringIncludes(openedUrl, "?token=");
            assertEquals(
                captured.logs.some((line) => line.includes(openedUrl)),
                true,
            );
        });
    });
}

test("runPlansUiCommand honors no-open while running the real Workspace server", async () => {
    await withPlansUiFixture(async () => {
        const controller = new AbortController();
        const browser: BrowserPort = {
            open: () => Promise.reject(new Error("browser port must not be called")),
        };
        const timer = setTimeout(() => controller.abort(), 25);
        try {
            const captured = await captureConsole(() =>
                runPlansUiCommand(["--no-open", "--port", "0"], { browser, signal: controller.signal }),
            );
            assertEquals(
                captured.logs.some((line) => line.includes("[RunWield] Workspace: http://127.0.0.1:")),
                true,
            );
        } finally {
            clearTimeout(timer);
        }
    });
});

test("runPlansUiCommand warns for an explicit non-loopback bind", async () => {
    await withPlansUiFixture(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25);
        try {
            const captured = await captureConsole(() =>
                runPlansUiCommand(["--bind=0.0.0.0", "--port=0", "--no-open"], {
                    browser: NO_OPEN_BROWSER_PORT,
                    signal: controller.signal,
                }),
            );
            assertEquals(
                captured.warnings.some((line) => line.includes("Warning") && line.includes("0.0.0.0")),
                true,
            );
        } finally {
            clearTimeout(timer);
        }
    });
});

test("runPlansUiCommand reports argument errors and prints real help", async () => {
    const invalid = await captureConsole(() =>
        runPlansUiCommand(["--port", "70000"], { browser: NO_OPEN_BROWSER_PORT }),
    );
    assertStringIncludes(invalid.errors.join("\n"), "Invalid --port value");
    assertStringIncludes(invalid.errors.join("\n"), "wld plans ui --help");

    const conflict = await captureConsole(() =>
        runPlansUiCommand(["--bind", "127.0.0.1", "--host", "localhost"], { browser: NO_OPEN_BROWSER_PORT }),
    );
    assertStringIncludes(conflict.errors.join("\n"), "Conflicting --bind and --host");

    const help = await captureConsole(() => runPlansUiCommand(["--help"], { browser: NO_OPEN_BROWSER_PORT }));
    assertStringIncludes(help.logs.join("\n"), "Usage: wld plans ui");
});
