import { test } from "node:test";
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { archivePlan, loadArchivedPlan, savePlan } from "../../plan-store.js";
import { runPlansReadCommand } from "./read.ts";
import { getRunWieldRuntimeDir } from "../../constants.js";
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

readTest("named read keeps raw legacy documents browseable with a pending notice", async ({ projectRoot }) => {
    const { mkdir, readFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(join(projectRoot, "docs/plans"), { recursive: true });
    const controllers = join(getRunWieldRuntimeDir(projectRoot), "controller/plans");
    await mkdir(controllers, { recursive: true });
    const path = join(projectRoot, "docs/plans/legacy.md");
    const markdown = "---\nplanId: legacy-id\nstatus: draft\n---\n# Legacy document\n";
    await writeFile(path, markdown);
    await writeFile(join(controllers, "legacy-id.json"), "{}\n");

    const result = await runReadAndClose(["legacy", "--no-open"]);

    assertStringIncludes(result.html, "Legacy document");
    assertStringIncludes(result.html, "Workflow details pending");
    assertEquals(await readFile(path, "utf8"), markdown);
});

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
    assertEquals(
        result.logs.some((line) => line.includes("Could not open your browser")),
        false,
    );
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

    await assertRejects(() => runPlansReadCommand(["duplicate-id", "--no-open"]), Error, "Duplicate archived planId");
    assertEquals((await loadArchivedPlan(projectRoot, "first"))?.body, "# First");
});

readTest("read command validates arguments and reports missing fixture Plans", async () => {
    await assertRejects(() => runPlansReadCommand([]), Error, "Missing Plan name or id");
    await assertRejects(() => runPlansReadCommand(["first", "second"]), Error, "Unexpected read argument: second");
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

readTest(
    "named read selects registered Plan bytes and passes pending availability to the reader",
    async ({ projectRoot }) => {
        const { defineGitFixture, git } = await import("../../shared/git-test-fixture.ts");
        const { cp, mkdir, writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { addEntry } = await import("../../shared/worktree-registry.js");
        // Copy a real fixture into the command fixture so cwd stays under its process lock.
        const fixture = defineGitFixture(async (root) => {
            await mkdir(join(root, "docs/plans"), { recursive: true });
            await writeFile(
                join(root, "docs/plans/selected.md"),
                "---\nplanId: selected-id\nstatus: draft\n---\n# Stale primary\n",
            );
            await git(root, ["add", "."]);
            await git(root, ["commit", "-m", "primary Plan"]);
        });
        const source = await fixture.checkout();
        const { rm } = await import("node:fs/promises");
        try {
            await cp(source, projectRoot, { recursive: true });
            const path = join(projectRoot, "execution");
            await git(projectRoot, ["worktree", "add", "-b", "execution", path]);
            await writeFile(
                join(path, "docs/plans/selected.md"),
                "---\nplanId: selected-id\nstatus: implemented\nexecutionReport: unimported report\n---\n# Registered authority\n",
            );
            await addEntry(projectRoot, {
                id: "attempt",
                planId: "selected-id",
                planName: "selected",
                path,
                branch: "execution",
                baseBranch: "main",
                baseRef: "main",
                baseCommit: await git(projectRoot, ["rev-parse", "HEAD"]),
                status: "active",
                createdAt: "now",
                updatedAt: "now",
            });
            const result = await runReadAndClose(["selected", "--no-open"]);
            assertStringIncludes(result.html, "Registered authority");
            assertStringIncludes(result.html, "Workflow details pending");
            assertEquals(result.html.includes("Stale primary"), false);
        } finally {
            await rm(source, { recursive: true, force: true });
        }
    },
);

readTest("explicit archived read preserves an unsafe registered-authority diagnostic", async ({ projectRoot }) => {
    const { mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { addEntry } = await import("../../shared/worktree-registry.js");
    const { RegisteredPlanDocumentUnavailableError } = await import("../../shared/workflow/controller-registry.ts");
    const path = join(projectRoot, "unowned-directory");
    await mkdir(path);
    await addEntry(projectRoot, {
        id: "unsafe-archive-attempt",
        planName: "done",
        planId: "done-id",
        path,
        branch: "execution",
        baseBranch: "main",
        baseRef: "refs/heads/main",
        baseCommit: "a".repeat(40),
        status: "active",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
    });
    await assertRejects(
        () => runPlansReadCommand(["archived/done", "--no-open"]),
        RegisteredPlanDocumentUnavailableError,
        "The primary copy will not be used",
    );
});

readTest("read by id preserves catalog errors instead of reporting a missing Plan", async ({ projectRoot }) => {
    await savePlan(projectRoot, "first", "# First", { status: "draft", planId: "duplicate-active-id" });
    await savePlan(projectRoot, "second", "# Second", { status: "draft", planId: "duplicate-active-id" });
    await assertRejects(
        () => runPlansReadCommand(["duplicate-active-id", "--no-open"]),
        Error,
        "Duplicate planId values",
    );
});

readTest("explicit archived read preserves document parse errors", async ({ projectRoot }) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const path = join(projectRoot, "docs/plans/archived");
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "broken.md"), "---\nplanId: [unterminated\n---\n# Broken archived Plan\n");
    await assertRejects(
        () => runPlansReadCommand(["archived/broken", "--no-open"]),
        Error,
        "Malformed archived Plan docs/plans/archived/broken.md",
    );
});
