import { test } from "node:test";
import { exerciseProof } from "./model-proof-fixture.ts";

test("LIVE proof refuses a reply that omits the tool result", () => exerciseProof(false));
