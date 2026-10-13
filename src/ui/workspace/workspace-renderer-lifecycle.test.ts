import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import process from "node:process";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { loadPlanBodyById, savePlanBodyById } from "../../plan-store.js";
import { createRendererFixture } from "../../../scripts/workspace-memory-fixture.ts";
import { RUNWIELD_ROOT } from "../../../runtime-root.js";

for (const mode of ["normal", "missing", "fallback", "disabled"]) {
    test(`renderer entry lifecycle: ${mode}`, async () => {
        const result = await captureForegroundProcess(process.execPath, {
            args: runtimeSourceArgs(["run", "-A", "scripts/workspace-renderer-probe.ts", mode]),
            cwd: RUNWIELD_ROOT,
        });
        assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
        const report = JSON.parse(new TextDecoder().decode(result.stdout));
        assertEquals(report.responses, 12);
        assertEquals(report.count[mode === "fallback" ? "runtime" : "source"], 1);
    });
}

test("module evaluation failure reports the error and restart action", async () => {
    const result = await captureForegroundProcess(process.execPath, {
        args: runtimeSourceArgs(["run", "-A", "scripts/workspace-renderer-probe.ts", "evaluation-failure"]),
        cwd: RUNWIELD_ROOT,
    });
    assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
    const report = JSON.parse(new TextDecoder().decode(result.stdout));
    assertStringIncludes(report.response, "restart");
    assertStringIncludes(new TextDecoder().decode(result.stderr), "Renderer evaluation failed");
});

test("fixture follows unprefixed Session and protected Plan navigation", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "renderer-navigation-"));
    const origin = "http://127.0.0.1";
    const fixture = await createRendererFixture(root, origin);
    try {
        const ownerPlan = fixture.routes.find((route) =>
            route.path.includes("/projects/") && route.path.endsWith("/plans")
        )!;
        const ownerSession = fixture.routes.find((route) =>
            route.path.includes("/sessions/") && !route.path.endsWith("/sessions")
        )!;
        for (
            const [path, referer, marker] of [
                [ownerPlan.path.replace("/fixture/owner", "") + "/fixture-id-0", ownerPlan.path, "Memory plan body 0"],
                [ownerSession.path.replace("/fixture/owner", ""), ownerPlan.path, "Project Session"],
                [ownerSession.path.replace("/fixture/owner", "").replace(/\/[^/]+$/, "/new"), ownerSession.path, "New"],
                ["/plans/fixture-id-1", "/fixture/local/plans/fixture-id-0", "Memory plan body 1"],
                ["/review/code", "/fixture/review/code", "Memory code review marker"],
                ["/session-question", "/fixture/question/session-question", "Memory question marker"],
            ]
        ) {
            const response = await fixture.request(
                path,
                new Request(`${origin}${path}`, {
                    headers: { referer: `${origin}${referer}` },
                }),
            );
            assertEquals(response.status, 200, path);
            assertStringIncludes(await response.text(), marker);
        }
    } finally {
        await fixture.close();
        await fsRm(root, { recursive: true });
    }
});

test("unprefixed Code Review loads without a referer and routes its APIs to Code Review", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "renderer-code-review-"));
    const origin = "http://127.0.0.1";
    const fixture = await createRendererFixture(root, origin);
    try {
        const page = await fixture.request("/review/code");
        assertEquals(page.status, 200);
        assertStringIncludes(await page.text(), "Memory code review marker");
        const apiPath = "/api/agents/capabilities";
        const api = await fixture.request(
            apiPath,
            new Request(`${origin}${apiPath}`, {
                headers: { referer: `${origin}/review/code` },
            }),
        );
        assertEquals(api.status, 200);
        assertEquals((await api.json()).mode, "review");
    } finally {
        await fixture.close();
        await fsRm(root, { recursive: true });
    }
});

test("shared renderer serves concurrent pages with independent current Plan, review and question content", async () => {
    const root = await fsMkdtemp(join(tmpdir(), "renderer-lifecycle-"));
    const fixture = await createRendererFixture(root, "http://127.0.0.1");
    try {
        const routes = [
            ["/fixture/local/plans/fixture-id-0", "Memory plan body 0"],
            ["/fixture/local/plans/fixture-id-1", "Memory plan body 1"],
            ["/fixture/review/plan", "Memory plan review marker"],
            ["/fixture/review/code", "Memory code review marker"],
            ["/fixture/question/session-question", "Memory question marker"],
            ...fixture.routes.filter((route) => route.path.startsWith("/fixture/owner/")).map((
                route,
            ) => [route.path, route.marker]),
        ];
        for (let round = 0; round < 2; round++) {
            const responses = await Promise.all(routes.map(async ([path, marker]) => {
                const response = await fixture.request(path);
                return { status: response.status, body: await response.text(), marker };
            }));
            for (const [index, { status, body, marker }] of responses.entries()) {
                assertEquals(status, 200, `${routes[index][0]}: ${body}`);
                assertStringIncludes(body, marker);
            }
        }
        const project = join(root, "project-a");
        const plan = await loadPlanBodyById(project, "fixture-id-0");
        await savePlanBodyById(
            project,
            "fixture-id-0",
            "# Fixture Plan 0\n\n## Context\n\nUpdated Plan body",
            plan.bodyHash,
            { expectedRevision: plan.revision },
        );
        const current = await fixture.request("/fixture/local/plans/fixture-id-0");
        assertEquals(current.status, 200);
        assertStringIncludes(await current.text(), "Updated Plan body");
        const other = await fixture.request("/fixture/local/plans/fixture-id-1");
        assertEquals(other.status, 200);
        assertStringIncludes(await other.text(), "Memory plan body 1");
    } finally {
        await fixture.close();
        await fsRm(root, { recursive: true });
    }
});
