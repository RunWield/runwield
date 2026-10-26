import assert from "node:assert/strict";
import { startValidation } from "../src/validation.ts";

const success = await startValidation(process.execPath, ["-e", 'console.log("checked")']).result;
assert.equal(success.status, "passed");
assert.equal(success.output.trim(), "checked");
console.log("PASS successful output");
const failure = await startValidation(process.execPath, ["-e", 'console.error("broken"); process.exit(7)']).result;
assert.equal(failure.status, "failed");
assert.equal(failure.code, 7);
assert.equal(failure.output.trim(), "broken");
console.log("PASS failed command");
await assert.rejects(startValidation("/missing-validation-command", []).result, /ENOENT/);
console.log("PASS unavailable command");
