import { test } from "node:test";
import { qualifyManagedStoreActivation } from "./managed-store-activation-fixture.ts";

test("managed laptop Plan publishes to local Git without a laptop checkout (copies true) parent recording", () =>
    qualifyManagedStoreActivation(false, true, true));
