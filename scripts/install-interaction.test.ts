import { bashFixturePath } from "./bash-fixture.ts";
import { test } from "node:test";
import { readFile as fsReadFile, rm as fsRm } from "node:fs/promises";
import { assertEquals, assertStringIncludes } from "../src/testing/assertions.ts";
import { join } from "node:path";

import { createFixture, runInstaller, runInstallerInPseudoTty } from "./install-test-helpers.js";

test("install.sh non-interactive mode prints one PATH recommendation without prompts", async () => {
    const fixture = await createFixture();
    try {
        const result = await runInstaller(fixture);
        assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
        assertStringIncludes(result.stdout, "Restart your shell or run:");
        assertStringIncludes(result.stdout, `export PATH=\"${bashFixturePath(fixture.installDir)}:$PATH\"`);
        assertEquals(result.stdout.includes("Add " + bashFixturePath(fixture.installDir) + " to your PATH"), false);
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});

test("install.sh recognizes newly installed Snip for filter setup before shell reload", async () => {
    const fixture = await createFixture();
    const filterLog = join(fixture.root, "filter.log");
    try {
        const result = await runInstallerInPseudoTty(fixture, "\nn\n", { extraEnv: { WLD_FILTER_LOG: filterLog } });
        assertEquals(result.code, 0, `${result.stdout}\n${result.stderr}`);
        assertStringIncludes(result.stdout, "RunWield Deno Snip filters installed");
        const log = await fsReadFile(filterLog, "utf8");
        assertStringIncludes(log, `snip=${bashFixturePath(join(fixture.installDir, "snip"))}`);
        assertStringIncludes(log, `path=${bashFixturePath(fixture.installDir)}:`);
    } finally {
        await fsRm(fixture.root, { recursive: true });
    }
});
