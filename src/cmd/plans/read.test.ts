import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { archivePlan, loadArchivedPlan, savePlan } from "../../plan-store.js";
import { runPlansReadCommand } from "./read.ts";
import { type PlanCommandFixture, withPlanCommandFixture } from "./plans-command-test-fixture.ts";

interface ReadSurfaceResult {
    html: string;
    logs: string[];
    url: string;
}

function readTest(name: string, run: (fixture: PlanCommandFixture) => Promise<void>): void {
    test(name, () => withPlanCommandFixture("runwield-plans-read-command-", run));
}

async function runReadAndClose(argv: string[]): Promise<ReadSurfaceResult> {
    const logs: string[] = [];
    let surfaceUrl = "";
    let commandError: Error | undefined;
    const original = console.log;
    console.log = (message = "") => {
        const line = String(message);
        logs.push(line);
        const prefix = "[RunWield] Plan read-only view: ";
        if (line.startsWith(prefix)) surfaceUrl = line.slice(prefix.length);
    };

    const command = runPlansReadCommand(argv).catch((error) => {
        commandError = error instanceof Error ? error : new Error(String(error));
    });
    try {
        for (let attempt = 0; attempt < 200 && !surfaceUrl && !commandError; attempt++) {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        if (!surfaceUrl) {
            await command;
            throw commandError || new Error("Plan read surface did not start.");
        }

        const url = new URL(surfaceUrl);
        const token = url.searchParams.get("token");
        if (!token) throw new Error("Plan read surface URL did not include its access token.");
        const html = await (await fetch(url)).text();
        const exitUrl = new URL("/api/review/exit", url);
        exitUrl.searchParams.set("token", token);
        const response = await fetch(exitUrl, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-runwield-review-token": token,
            },
            body: JSON.stringify({ reviewType: "plan" }),
        });
        assertEquals(response.status, 200);
        await command;
        if (commandError) throw commandError;
        return { html, logs, url: surfaceUrl };
    } finally {
        console.log = original;
    }
}

readTest("read command renders the active Plan when an archived Plan has the same name", async ({ projectRoot }) => {
    await savePlan(projectRoot, "same", "# Archived Marker", {
        status: "verified",
        planId: "archived-same-id",
    });
    await archivePlan(projectRoot, "same");
    await savePlan(projectRoot, "same", "# Active Marker", {
        status: "draft",
        planId: "active-same-id",
    });

    const result = await runReadAndClose(["same", "--no-open"]);

    assertStringIncludes(result.html, "artifact-read");
    assertStringIncludes(result.html, "Active Marker");
    assertEquals(result.html.includes("Archived Marker"), false);
    assertEquals(result.logs.some((line) => line.includes("Could not open your browser")), false);
});

readTest("read command resolves explicitly addressed archived Plans in the real store", async ({ projectRoot }) => {
    await savePlan(projectRoot, "done", "# Archived Body Marker", {
        status: "verified",
        planId: "archived-id",
    });
    await archivePlan(projectRoot, "done");

    const result = await runReadAndClose(["archived/done", "--no-open"]);

    assertStringIncludes(result.html, "Archived Body Marker");
    assertStringIncludes(result.html, "docs/plans/archived/done.md");
});

readTest("read command resolves archived Plans by durable id", async ({ projectRoot }) => {
    await savePlan(projectRoot, "archived-match", "# Archived By ID Marker", {
        status: "verified",
        planId: "archived-id",
    });
    await archivePlan(projectRoot, "archived-match");

    const result = await runReadAndClose(["archived-id", "--no-open"]);

    assertStringIncludes(result.html, "Archived By ID Marker");
    assertStringIncludes(result.html, "docs/plans/archived/archived-match.md");
});

readTest("read command resolves active Plans by durable id", async ({ projectRoot }) => {
    await savePlan(projectRoot, "active-match", "# Active By ID Marker", {
        status: "draft",
        planId: "active-id",
    });

    const result = await runReadAndClose(["active-id", "--no-open"]);

    assertStringIncludes(result.html, "Active By ID Marker");
    assertStringIncludes(result.html, "active-match");
});

readTest("read command reports duplicate archived durable ids from fixture Plans", async ({ projectRoot }) => {
    await savePlan(projectRoot, "archived/first", "# First", {
        status: "verified",
        planId: "duplicate-id",
    });
    await savePlan(projectRoot, "archived/second", "# Second", {
        status: "verified",
        planId: "duplicate-id",
    });

    await assertRejects(
        () => runPlansReadCommand(["duplicate-id", "--no-open"]),
        Error,
        "Duplicate archived planId",
    );
    assertEquals((await loadArchivedPlan(projectRoot, "first"))?.body, "# First");
});

readTest("read command validates arguments and reports missing fixture Plans", async () => {
    await assertRejects(() => runPlansReadCommand([]), Error, "Missing Plan name or id");
    await assertRejects(
        () => runPlansReadCommand(["first", "second"]),
        Error,
        "Unexpected read argument: second",
    );
    await assertRejects(() => runPlansReadCommand(["--wat"]), Error, "Unexpected read argument: --wat");
    await assertRejects(
        () => runPlansReadCommand(["does-not-exist", "--no-open"]),
        Error,
        "Plan not found: does-not-exist",
    );

    const logs: string[] = [];
    const original = console.log;
    console.log = (message = "") => logs.push(String(message));
    try {
        await runPlansReadCommand(["--help"]);
    } finally {
        console.log = original;
    }
    assertStringIncludes(logs.join("\n"), "plans read [--no-open]");
});
