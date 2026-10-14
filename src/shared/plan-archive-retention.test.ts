import { assertEquals } from "../testing/assertions.ts";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archivePlan, savePlan } from "../plan-store.js";
import {
    type ArchivedPlanUnit,
    collectArchivedPlanUnits,
    selectArchivedPlansForPrune,
} from "./plan-archive-retention.ts";

function unit(name: string, planId: string | undefined, archivedAt: string | undefined): ArchivedPlanUnit {
    return { name, planId, archivedAt, paths: [] };
}

test("archive retention selection excludes ineligible units from deletion and keepLast slots", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const old = "2026-08-01T00:00:00Z";
    const recent = "2026-08-30T00:00:00Z";

    const selection = selectArchivedPlansForPrune({
        units: [
            unit("old", "p1", old),
            unit("recent-a", "p2", recent),
            unit("recent-b", "p3", recent),
            unit("no-work-record-a", "x1", old),
            unit("no-plan-id", undefined, old),
        ],
        workRecordPlanIds: new Set(["p1", "p2", "p3"]),
        policy: { retentionDays: 14, keepLast: 2 },
        now,
    });

    assertEquals(selection.due.map((entry) => entry.name), ["old"]);
    assertEquals(selection.sparedByKeepLast.map((entry) => entry.name), ["recent-a", "recent-b"]);
    assertEquals(selection.ineligible.map((entry) => entry.name), ["no-work-record-a", "no-plan-id"]);
});

test("archive retention selection supports zero-day retention and missing archivedAt", () => {
    const now = new Date("2026-09-01T00:00:00Z");

    const selection = selectArchivedPlansForPrune({
        units: [
            unit("just-now", "p1", now.toISOString()),
            unit("missing-date", "p2", undefined),
        ],
        workRecordPlanIds: new Set(["p1", "p2"]),
        policy: { retentionDays: 0, keepLast: 0 },
        now,
    });

    assertEquals(selection.due.map((entry) => entry.name), ["just-now", "missing-date"]);
});

test("collectArchivedPlanUnits groups an Epic parent, child Plans, and manual QA artifact", async () => {
    const cwd = await fsMkdtemp(join(tmpdir(), "runwield-archive-retention-units-"));
    try {
        await savePlan(cwd, "epic", "# Epic", {
            classification: "PROJECT",
            status: "verified",
            planId: "epic-id",
        });
        await savePlan(cwd, "epic/01-child", "# Child", {
            classification: "FEATURE",
            parentPlan: "epic",
            status: "verified",
            planId: "child-id",
        });
        await fsMkdir(join(cwd, "docs", "plans", "epic"), { recursive: true });
        await fsWriteFile(join(cwd, "docs", "plans", "epic", "manual-qa.md"), "# QA\n");

        await archivePlan(cwd, "epic/01-child", { now: "2026-08-01T00:00:00Z" });
        await archivePlan(cwd, "epic", { now: "2026-08-01T00:00:00Z" });

        const units = await collectArchivedPlanUnits(cwd);
        assertEquals(units, [{
            name: "epic",
            planId: "epic-id",
            archivedAt: "2026-08-01T00:00:00Z",
            paths: [
                "docs/plans/archived/epic.md",
                "docs/plans/archived/epic/01-child.md",
                "docs/plans/archived/epic/manual-qa.md",
            ],
        }]);
    } finally {
        await fsRm(cwd, { recursive: true });
    }
});
