import { test } from "node:test";
import { recoverDelivery } from "./delivery-recovery-test-fixture.ts";

for (const point of [
    "artifacts_committed",
    "target_integrated",
    "target_published",
    "publication_verified",
    "cleanup_complete",
    "delivered_record",
]) {
    for (const timing of ["before", "after"]) {
        test(`fresh Attached process recovers ${timing} ${point} without repeating accepted work`, async () => {
            await recoverDelivery(point, timing);
        });
    }
}
