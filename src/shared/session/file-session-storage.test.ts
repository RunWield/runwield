import { test } from "node:test";
import { portableStorageCases } from "../testing/portable-storage-cases.ts";

for (const testCase of portableStorageCases) test(testCase.name, testCase.run);
