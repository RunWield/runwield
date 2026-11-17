import { equal } from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { recordingFixture } from "./package-recording-fixture.ts";
import { read } from "../../testing/plan-package-fixture.ts";
import { readPlanPackagePublication } from "../../../plan-store/packages.ts";
import { listWorkRecords } from "../../work-records/store.ts";
import { withWorkRecordOwner } from "../../work-records/owner.ts";
import { git } from "../../git-test-fixture.ts";
import { setExactProjectCustomSetting } from "../../settings.js";

export async function assertRecordingResumes(boundary: string) {
    const f = await recordingFixture();
    try {
        const stopped = await f.validate({ boundary });
        equal(stopped.code, 86, stopped.text);
        const count = await f.turns();
        const target = await git(f.remote, ["rev-parse", "main"]);
        setExactProjectCustomSetting("plans", { deliveryCopies: true }, f.root);
        setExactProjectCustomSetting("workRecords", { deliveryCopies: false }, f.root);
        await fs.writeFile(join(f.p.path, "context.md"), "# Later editor prose\n");
        const resumed = await f.validate();
        equal(resumed.code, 0, resumed.text);
        equal(resumed.outcome?.kind, "verified", resumed.text);
        equal(await f.turns(), boundary === "source" ? count + 1 : count);
        const receipt = (await read(f.identity)).metadata.workflow!.delivery!;
        const manifest = await readPlanPackagePublication(f.identity, receipt.source);
        equal(manifest.planCopies, false);
        equal(manifest.workRecordCopies, true);
        equal(await fs.readFile(join(f.p.path, "context.md"), "utf8"), "# Later editor prose\n");
        await withWorkRecordOwner(f.root, f.identity, async () => {
            const records = await listWorkRecords(f.root);
            equal(records.length, 1);
            equal(records[0].attrs.status, "approved");
            equal(records[0].attrs.recordId, (await f.recorderIds())[0]);
        });
        equal(
            (await git(f.remote, ["log", "--format=%B", "main"])).split("RunWield-Publication-Attempt:").length - 1,
            1,
        );
        if (["approval", "locations", "settled", "index"].includes(boundary))
            equal(await git(f.remote, ["rev-parse", "main"]), target);
    } finally {
        await f.cleanup();
    }
}
