/** Run the storage contract under Bun or Node; every case owns a disposable directory. */
import { portableStorageCases } from "../src/shared/testing/portable-storage-cases.ts";
import { privateJsonFileCases, runPrivateJsonFileCase } from "../src/shared/testing/private-json-file-cases.ts";

for (const testCase of privateJsonFileCases) {
    runPrivateJsonFileCase(testCase);
    console.log(`PASS ${testCase.name}`);
}
for (const testCase of portableStorageCases) {
    testCase.run();
    console.log(`PASS ${testCase.name}`);
}
console.log(`${privateJsonFileCases.length + portableStorageCases.length} portable storage checks passed`);
