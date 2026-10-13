import { test } from "node:test";
import { privateJsonFileCases, runPrivateJsonFileCase } from "./testing/private-json-file-cases.ts";

for (const testCase of privateJsonFileCases) {
    test(testCase.name, () => runPrivateJsonFileCase(testCase));
}
