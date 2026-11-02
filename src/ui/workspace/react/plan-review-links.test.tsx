// @ts-nocheck: Browser tests install happy-dom globals around the real review surface.
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import { reviewFileContentApi } from "../routes/api/review-file-handlers.ts";
import { withReview } from "./plan-review-test-dom.tsx";

for (const mode of ["standalone", "workspace"]) {
    test(`Plan Review opens a nested Plan's relative Epic link in ${mode} mode`, async () => {
        const cwd = await mkdtemp(join(tmpdir(), "review-links-"));
        try {
            await mkdir(join(cwd, "docs/plans/external-plan-store"), { recursive: true });
            await writeFile(join(cwd, "docs/plans/external-plan-store.md"), "# External Plan Store Epic\n");
            await withReview(
                async ({ container }) => {
                    const previousFetch = globalThis.fetch;
                    let requested;
                    globalThis.fetch = (url, options) => {
                        if (!String(url).includes("content?")) return previousFetch(url, options);
                        requested = new URL(url, "http://localhost");
                        // Inspect the request without mounting the code viewer's browser-only custom element.
                        return new Promise(() => {});
                    };
                    await act(() => container.querySelector('a[href="../external-plan-store.md"]').click());
                    assertEquals(requested.searchParams.get("base"), "docs/plans/external-plan-store");
                    assertEquals(
                        requested.pathname,
                        mode === "workspace" ? "/api/owner/projects/project-1/files/content" : "/api/file-content",
                    );
                    const response = await reviewFileContentApi(new Request(requested), { cwd });
                    const body = await response.json();
                    assertEquals(body.codeFile, true);
                    assertStringIncludes(body.contents, "External Plan Store Epic");
                },
                "# Child Plan\n\n[Epic](../external-plan-store.md)\n",
                {
                    mode,
                    projectId: "project-1",
                    planPath: "docs/plans/external-plan-store/plan-2.md",
                },
            );
        } finally {
            await rm(cwd, { recursive: true });
        }
    });
}
