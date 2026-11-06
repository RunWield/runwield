import { test } from "node:test";
import { recoverDelivery } from "./delivery-recovery-test-fixture.ts";

for (const point of ["recorder_sections", "record_saved"]) {
    for (const timing of point === "record_saved" ? ["after"] : ["before", "after"]) {
        test(`fresh Attached process recovers ${timing} ${point} without repeating accepted work`, async () => {
            await recoverDelivery(point, timing);
        });
    }
}
