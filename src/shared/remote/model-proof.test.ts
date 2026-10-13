import { test } from "node:test";
import { exerciseProof } from "./model-proof-fixture.ts";

test("LIVE proof confirms a remote sentinel through a model reply", () => exerciseProof(true));
