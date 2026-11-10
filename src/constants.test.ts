import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { mkdtemp as fsMkdtemp, readdir as fsReaddir, readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "./testing/assertions.ts";
import {
    AGENT_DEFS_DIR,
    CATPPUCCIN_MOCHA_THEME_PATH,
    formatPlannedWorkLabel,
    normalizeWorkKind,
    PROMPT_TEMPLATES_DIR,
    SKILLS_DIR,
    SNIP_FILTERS_DIR,
    SYSTEM_PROMPT_TEMPLATE_PATH,
} from "./constants.ts";
import { getWorkflowMetricsFilePath } from "./shared/workflow/metrics.js";
import { withProcessGlobalTestLock } from "./testing/process-global-lock.ts";

test("bundled resource constants point to file-readable assets", async () => {
    assertStringIncludes(await fsReadFile(CATPPUCCIN_MOCHA_THEME_PATH, "utf8"), "catppuccin-mocha");
    assertStringIncludes(await fsReadFile(SYSTEM_PROMPT_TEMPLATE_PATH, "utf8"), "{{AGENT_PROMPT}}");

    for (const dir of [AGENT_DEFS_DIR, PROMPT_TEMPLATES_DIR, SKILLS_DIR, SNIP_FILTERS_DIR]) {
        const entries = [];
        for await (const entry of await fsReaddir(dir, { withFileTypes: true })) entries.push(entry.name);
        assert(entries.length > 0);
    }
});

test("documentation Work Kind normalizes and labels planned documentation", () => {
    assertEquals(normalizeWorkKind("DOCUMENTATION"), "DOCUMENTATION");
    assertEquals(normalizeWorkKind("DOCS"), undefined);
    assertEquals(normalizeWorkKind(null), undefined);
    assertEquals(formatPlannedWorkLabel("DOCUMENTATION"), "Planned documentation");
});

test("home-derived paths follow a swapped HOME rather than a stale snapshot", async () => {
    await withProcessGlobalTestLock(async () => {
        const originalHome = process.env["HOME"];
        const tempHome = await fsMkdtemp(join(tmpdir(), "runwield-home-derived-"));
        try {
            process.env["HOME"] = tempHome;
            // Workflow metrics leaked into the real ~/.wld, so assert it concretely.
            const metricsPath = getWorkflowMetricsFilePath("/some/project");
            assertEquals(metricsPath.startsWith(tempHome), true, `Expected ${metricsPath} under ${tempHome}.`);
            if (originalHome) assertEquals(metricsPath.startsWith(join(originalHome, ".wld")), false);
        } finally {
            if (originalHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = originalHome;
            await fsRm(tempHome, { recursive: true });
        }
    });
});
