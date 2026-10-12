import { test } from "node:test";
import { CRASH_BOUNDARIES, runCrashCase } from "./publication-machine-test-helpers.ts";

test("publication survives process death at every effect and receipt boundary in local mode", async (test) => {
    const mode = "local";
    for (const crashAfter of CRASH_BOUNDARIES) {
        await test.test(`${mode}:${crashAfter}`, async () => await runCrashCase(mode, crashAfter));
    }
});

test("publication restart accepts later target commits without publishing again (local)", async (test) => {
    const mode = "local";
    for (const boundary of ["target_effect", "target_receipt", "verification_receipt", "cleanup_effect"]) {
        await test.test(`${mode}:${boundary}`, async () => await runCrashCase(mode, boundary, true));
    }
});
