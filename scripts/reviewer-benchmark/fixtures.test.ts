import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURE_GROUPS, loadFixture } from "./fixtures.ts";
import { corpusPath, corpusIds, withFixtureCopy } from "./test-fixtures.ts";

for (const id of corpusIds) {
    test(`${id} loads the reviewed manifest, oracle, and all required proof commands`, async () => {
        const fixture = await loadFixture(join(corpusPath, id));
        assert.equal(fixture.manifest.scenarioId, id);
        assert.ok(FIXTURE_GROUPS.includes(fixture.manifest.group));
        assert.equal(fixture.oracle.variants.A!.expectedDecision, "reject");
        assert.equal(fixture.oracle.variants.B?.expectedDecision, id === "RV-M01" ? undefined : "approve");
        assert.ok(Object.keys(fixture.oracle.proofs).length > 0);
    });
}

interface InvalidInput {
    name: string;
    file: string;
    from: string;
    to: string;
    error: RegExp;
}
const invalidInputs: InvalidInput[] = [
    {
        name: "missing coverage group",
        file: "scenario.yaml",
        from: "group: correctness-beyond-plan\n",
        to: "",
        error: /invalid coverage group/,
    },
    {
        name: "unknown coverage group",
        file: "scenario.yaml",
        from: "group: correctness-beyond-plan",
        to: "group: custom-plan-group",
        error: /invalid coverage group/,
    },
    {
        name: "malformed scenario ID",
        file: "scenario.yaml",
        from: "scenarioId: RV-D04",
        to: "scenarioId: RV-D004",
        error: /invalid scenario ID/,
    },
    {
        name: "scenario directory mismatch",
        file: "scenario.yaml",
        from: "scenarioId: RV-D04",
        to: "scenarioId: RV-D99",
        error: /scenario directory mismatch/,
    },
    {
        name: "schema version",
        file: "scenario.yaml",
        from: "schemaVersion: 1",
        to: "schemaVersion: 7",
        error: /unsupported schema/,
    },
    {
        name: "escaping Plan",
        file: "scenario.yaml",
        from: "docs/plans/reuse-plan-summaries.md",
        to: "../evaluation/oracle.yaml",
        error: /unsafe path/,
    },
    {
        name: "shell command",
        file: "scenario.yaml",
        from: "bun run test",
        to: "bun run test && echo unsafe",
        error: /unsupported public validation/,
    },
    {
        name: "unbounded timeout",
        file: "scenario.yaml",
        from: "timeoutMs: 120000",
        to: "timeoutMs: 0",
        error: /invalid timeout/,
    },
    {
        name: "unmatched proof marker",
        file: "evaluation/oracle.yaml",
        from: "expectedFailureMarker: RV-D04-CACHE-SCOPE",
        to: "expectedFailureMarker: RV-D04-OTHER",
        error: /proof marker mismatch/,
    },
    {
        name: "unsafe proof selector",
        file: "evaluation/oracle.yaml",
        from: "command: bun run test:oracle project-scope",
        to: "command: bun run test:oracle project-scope; echo unsafe",
        error: /invalid proof command/,
    },
    {
        name: "escaping patch",
        file: "evaluation/oracle.yaml",
        from: "variants/defective.patch",
        to: "variants/../../outside.patch",
        error: /unsafe path/,
    },
    {
        name: "missing patch",
        file: "evaluation/oracle.yaml",
        from: "variants/defective.patch",
        to: "variants/missing.patch",
        error: /ENOENT/,
    },
];
for (const input of invalidInputs) {
    test(`rejects ${input.name} before materialization`, async () => {
        await withFixtureCopy("RV-D04", async (packageDir) => {
            const path = join(packageDir, input.file);
            const original = await readFile(path, "utf8");
            assert.ok(original.includes(input.from));
            await writeFile(path, original.replace(input.from, input.to));
            await assert.rejects(loadFixture(packageDir), input.error);
        });
    });
}

for (const path of ["../outside.ts", "/absolute.ts", ".git/config", ".wld/settings.json", "evaluation/oracle.yaml"]) {
    test(`rejects patch destination ${path}`, async () => {
        await withFixtureCopy("RV-D04", async (packageDir) => {
            const patch = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+not allowed\n`;
            await writeFile(join(packageDir, "variants/clean.patch"), patch);
            await assert.rejects(loadFixture(packageDir), /unsafe path|private patch path/);
        });
    });
}

test("rejects patches that create symlinks", async () => {
    await withFixtureCopy("RV-D04", async (packageDir) => {
        await writeFile(
            join(packageDir, "variants/clean.patch"),
            "diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+../outside\n",
        );
        await assert.rejects(loadFixture(packageDir), /non-regular patch mode/);
    });
});

test("rejects source symlinks instead of following them outside the source tree", async () => {
    await withFixtureCopy("RV-D04", async (packageDir) => {
        await symlink("../evaluation", join(packageDir, "source/notes"));
        await assert.rejects(loadFixture(packageDir), /non-regular source entry/);
    });
});

test("rejects a symlink used as a variant patch", async () => {
    await withFixtureCopy("RV-D04", async (packageDir) => {
        await symlink("defective.patch", join(packageDir, "variants/link.patch"));
        const path = join(packageDir, "evaluation/oracle.yaml");
        await writeFile(
            path,
            (await readFile(path, "utf8")).replace("variants/defective.patch", "variants/link.patch"),
        );
        await assert.rejects(loadFixture(packageDir), /symlink/);
    });
});

test("rejects an independence matrix that claims one repair fixes both defects", async () => {
    await withFixtureCopy("RV-M01", async (packageDir) => {
        const path = join(packageDir, "evaluation/oracle.yaml");
        await writeFile(
            path,
            (await readFile(path, "utf8")).replace("empty-cursor-page: fail", "empty-cursor-page: pass"),
        );
        await assert.rejects(loadFixture(packageDir), /incorrect independence matrix/);
    });
});

for (const id of ["RV-D99", "RV-M99"]) {
    test(`accepts corpus scenario ${id} outside the smoke set with an allowed group`, async () => {
        await withFixtureCopy("RV-D04", async (packageDir) => {
            const destination = join(packageDir, "..", id);
            await rename(packageDir, destination);
            for (const file of ["scenario.yaml", "evaluation/oracle.yaml"]) {
                const path = join(destination, file);
                await writeFile(
                    path,
                    (await readFile(path, "utf8"))
                        .replace("scenarioId: RV-D04", `scenarioId: ${id}`)
                        .replace("group: correctness-beyond-plan", "group: cross-file-context"),
                );
            }
            const fixture = await loadFixture(destination);
            assert.equal(fixture.manifest.scenarioId, id);
            assert.equal(fixture.manifest.group, "cross-file-context");
        });
    });
}
