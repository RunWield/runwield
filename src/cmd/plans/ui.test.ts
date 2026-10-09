import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { savePlan } from "../../plan-store.js";
import { type BrowserPort, NO_OPEN_BROWSER_PORT } from "../../shared/browser-port.ts";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import { buildPlansUiUrl, isLoopbackHost, parsePlansUiArgs, runPlansUiCommand } from "./ui.ts";

interface CapturedConsole {
    errors: string[];
    logs: string[];
    warnings: string[];
}

async function withPlansUiFixture(run: (projectRoot: string) => Promise<void>): Promise<void> {
    await withProcessGlobalTestLock(async () => {
        const previousCwd = Deno.cwd();
        const projectRoot = await Deno.makeTempDir({ prefix: "runwield-plans-ui-" });
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
            Deno.chdir(projectRoot);
            await run(projectRoot);
        } finally {
            Deno.chdir(previousCwd);
            await Deno.remove(projectRoot, { recursive: true });
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

Deno.test("parsePlansUiArgs defaults to loopback random port", () => {
    assertEquals(parsePlansUiArgs([]), {
        host: "127.0.0.1",
        port: 0,
        noOpen: false,
        help: false,
        explicitBind: false,
    });
});

Deno.test("parsePlansUiArgs accepts bind, host alias, port, no-open, and help", () => {
    assertEquals(parsePlansUiArgs(["--host", "localhost", "--port", "8765", "--no-open"]).host, "localhost");
    assertEquals(parsePlansUiArgs(["--bind=0.0.0.0", "--port=0"]).explicitBind, true);
    assertEquals(parsePlansUiArgs(["--help"]).help, true);
});

Deno.test("parsePlansUiArgs rejects conflicting host bind and invalid ports", () => {
    assertThrows(() => parsePlansUiArgs(["--bind", "127.0.0.1", "--host", "localhost"]));
    assertThrows(() => parsePlansUiArgs(["--port", "70000"]));
});

Deno.test("isLoopbackHost detects loopback hosts", () => {
    assertEquals(isLoopbackHost("127.0.0.1"), true);
    assertEquals(isLoopbackHost("localhost"), true);
    assertEquals(isLoopbackHost("0.0.0.0"), false);
});

Deno.test("buildPlansUiUrl includes token and loopback URL for wildcard bind", () => {
    assertEquals(
        buildPlansUiUrl({ host: "0.0.0.0", port: 4321, token: "secret" }),
        "http://127.0.0.1:4321/?token=secret",
    );
});

Deno.test("buildPlansUiUrl brackets IPv6 loopback hosts", () => {
    assertEquals(
        buildPlansUiUrl({ host: "::1", port: 4321, token: "secret" }),
        "http://[::1]:4321/?token=secret",
    );
});

Deno.test("runPlansUiCommand serves fixture Plans through the authenticated Workspace API", async () => {
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
            runPlansUiCommand(["--port", "0"], { browser, signal: controller.signal })
        );

        assertStringIncludes(openedUrl, "http://127.0.0.1:");
        assertStringIncludes(openedUrl, "?token=");
        assertEquals(captured.logs.some((line) => line.includes(openedUrl)), true);
    });
});

Deno.test("runPlansUiCommand honors no-open while running the real Workspace server", async () => {
    await withPlansUiFixture(async () => {
        const controller = new AbortController();
        const browser: BrowserPort = {
            open: () => Promise.reject(new Error("browser port must not be called")),
        };
        const timer = setTimeout(() => controller.abort(), 25);
        try {
            const captured = await captureConsole(() =>
                runPlansUiCommand(["--no-open", "--port", "0"], { browser, signal: controller.signal })
            );
            assertEquals(captured.logs.some((line) => line.includes("[RunWield] Workspace: http://127.0.0.1:")), true);
        } finally {
            clearTimeout(timer);
        }
    });
});

Deno.test("runPlansUiCommand warns for an explicit non-loopback bind", async () => {
    await withPlansUiFixture(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25);
        try {
            const captured = await captureConsole(() =>
                runPlansUiCommand(["--bind", "0.0.0.0", "--port", "0", "--no-open"], {
                    browser: NO_OPEN_BROWSER_PORT,
                    signal: controller.signal,
                })
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

Deno.test("runPlansUiCommand reports argument errors and prints real help", async () => {
    const invalid = await captureConsole(() =>
        runPlansUiCommand(["--port", "70000"], { browser: NO_OPEN_BROWSER_PORT })
    );
    assertStringIncludes(invalid.errors.join("\n"), "Invalid --port value");
    assertStringIncludes(invalid.errors.join("\n"), "wld plans ui --help");

    const help = await captureConsole(() => runPlansUiCommand(["--help"], { browser: NO_OPEN_BROWSER_PORT }));
    assertStringIncludes(help.logs.join("\n"), "Usage: wld plans ui");
});
