import { test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { removeExecutableFixtureDirectory } from "../src/testing/runtime-executable-fixture.ts";
import { assertEquals, assertRejects } from "../src/testing/assertions.ts";
import { compileBun } from "./compile-bun.ts";
import { captureScriptProcess } from "./script-process.ts";
import { customEntry, makeControlFixture } from "../src/shared/remote/session-save-test-fixture.ts";

test("diagnostic entrypoints compile with the real embedded runtime payload", async () => {
    await mkdir(".ci-cache", { recursive: true });
    const root = await mkdtemp(resolve(".ci-cache/compile-entry-"));
    const entry = join(root, "diagnostic.ts");
    const binary = join(root, process.platform === "win32" ? "diagnostic.exe" : "diagnostic");
    try {
        await writeFile(
            entry,
            `
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNWIELD_ROOT } from "../../runtime-root.js";
console.log(JSON.stringify({ marker: "real-diagnostic-entry", logo: readFileSync(join(RUNWIELD_ROOT, "brand/logo.svg"), "utf8") }));
`,
        );
        await compileBun(binary, undefined, undefined, undefined, entry);
        const firstIdentity = JSON.parse(await readFile(`${binary}.build.json`, "utf8")).buildId;
        const firstSource = await readFile(entry, "utf8");
        await writeFile(entry, firstSource.replace("real-diagnostic-entry", "changed-diagnostic-entry"));
        const changedBinary = `${binary}.changed${process.platform === "win32" ? ".exe" : ""}`;
        await compileBun(changedBinary, undefined, undefined, undefined, entry);
        const changedIdentity = JSON.parse(await readFile(`${changedBinary}.build.json`, "utf8")).buildId;
        assertEquals(firstIdentity === changedIdentity, false, "Diagnostic source bytes must affect build identity");
        await rm(entry);
        const output = await captureScriptProcess(binary, {
            args: ["--version"],
            cwd: root,
            signal: AbortSignal.timeout(15_000),
        });
        assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
        assertEquals(JSON.parse(new TextDecoder().decode(output.stdout)), {
            marker: "real-diagnostic-entry",
            logo: await readFile("brand/logo.svg", "utf8"),
        });
    } finally {
        await removeExecutableFixtureDirectory(root);
    }
});

test("relocated production CLI saves a remote Session without source files or an event-loop turn", async () => {
    const fixture = await makeControlFixture();
    const binary = join(fixture.root, process.platform === "win32" ? "wld.exe" : "wld");
    try {
        await fixture.ready();
        await compileBun(binary);
        const contents = customEntry();
        // On macOS also deny access to checkout source and dependencies. Other hosts
        // still run from a separate project with no runtime files beside the binary.
        const sandbox = `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(resolve("."))}))`;
        const output = await captureScriptProcess(process.platform === "darwin" ? "/usr/bin/sandbox-exec" : binary, {
            args: [
                ...(process.platform === "darwin" ? ["-p", sandbox, binary] : []),
                "package-smoke",
                "remote-session-save",
            ],
            cwd: fixture.remoteProject,
            env: { HOME: fixture.home, USERPROFILE: fixture.home, WLD_INTERNAL_PACKAGE_CHECK: "1" },
            input: JSON.stringify({
                connection: {
                    baseUrl: fixture.baseUrl,
                    credential: fixture.control.credential,
                    operation: fixture.owner.operation,
                    timeoutMs: 1000,
                },
                contents,
            }),
            signal: AbortSignal.timeout(15_000),
        });
        assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
        assertEquals(new TextDecoder().decode(output.stdout).includes("Packaged remote Session save passed."), true);
        assertEquals(fixture.owner.inspect().contents, fixture.initial + contents);
        assertEquals(
            fixture.store.inspectSessionActivation(fixture.session.runwieldSessionId).generation?.generation,
            0,
        );
    } finally {
        await fixture.close();
    }
});

test("compiler rejects an entrypoint outside the repository before staging", async () => {
    await assertRejects(
        () => compileBun("unused", undefined, undefined, undefined, "../outside.ts"),
        Error,
        "inside the repository",
    );
});
