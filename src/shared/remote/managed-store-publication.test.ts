import { test } from "node:test";
import { qualifyManagedStoreActivation } from "./managed-store-activation-fixture.ts";

for (const copies of [false, true]) {
    test(`managed laptop Plan publishes to upstream Git without a laptop checkout (copies ${copies})`, () =>
        qualifyManagedStoreActivation(true, copies, false));
}
