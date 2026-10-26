import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixture } from "./fixtures.ts";
import { admitFixtures } from "./admission.ts";
import { corpusPath, corpusIds, withFixtureCopy } from "./test-fixtures.ts";

interface ExpectedChecks {
    variants: number;
    public: number;
    proofs: number;
}
const counts: Record<string, ExpectedChecks> = {
    "RV-D01": { variants: 2, public: 2, proofs: 2 },
    "RV-D02": { variants: 2, public: 2, proofs: 2 },
    "RV-D03": { variants: 2, public: 2, proofs: 2 },
    "RV-D04": { variants: 2, public: 2, proofs: 6 },
    "RV-D05": { variants: 2, public: 2, proofs: 2 },
    "RV-D06": { variants: 2, public: 2, proofs: 2 },
    "RV-D07": { variants: 2, public: 2, proofs: 2 },
    "RV-D08": { variants: 2, public: 2, proofs: 2 },
    "RV-D09": { variants: 2, public: 2, proofs: 2 },
    "RV-D10": { variants: 2, public: 2, proofs: 2 },
    "RV-D12": { variants: 2, public: 4, proofs: 4 },
    "RV-D13": { variants: 2, public: 2, proofs: 2 },
    "RV-M01": { variants: 1, public: 4, proofs: 8 },
};

test("every corpus package has explicit admission check counts", () => {
    assert.deepEqual(Object.keys(counts).sort(), corpusIds);
});

for (const id of corpusIds) {
    test(`${id} admits all public outcomes and hidden proofs, including clean and partial repairs`, async () => {
        const before = await projectDirectories();
        const admitted = await admitFixtures([await loadFixture(join(corpusPath, id))]);
        assert.deepEqual(admitted, [
            {
                scenarioId: id,
                variantCount: counts[id].variants,
                publicChecks: counts[id].public,
                proofChecks: counts[id].proofs,
            },
        ]);
        assert.deepEqual(await projectDirectories(), before);
    });
}

async function projectDirectories(): Promise<string[]> {
    return (await readdir(tmpdir())).filter((name) => name.startsWith("project-")).sort();
}

interface BadProof {
    name: string;
    content: string;
}
const badProofs: BadProof[] = [
    { name: "proof passes on both variants", content: 'console.log("PASS");\n' },
    {
        name: "unrelated error contains the marker and AssertionError text",
        content: 'throw new Error("AssertionError: RV-D04-CACHE-SCOPE");\n',
    },
    {
        name: "assertion has a different message containing the marker",
        content: 'import assert from "node:assert/strict";\nassert.equal(1, 2, "not RV-D04-CACHE-SCOPE");\n',
    },
    {
        name: "module cannot load despite marker text in its source",
        content: 'import "./missing.ts";\n// AssertionError: RV-D04-CACHE-SCOPE\n',
    },
];
for (const proof of badProofs) {
    test(`rejects admission when ${proof.name} and cleans all projects`, async () => {
        await withFixtureCopy("RV-D04", async (packageDir) => {
            await writeFile(join(packageDir, "evaluation/proofs.ts"), proof.content);
            const before = await projectDirectories();
            let prerequisiteFinished = false;
            await assert.rejects(async () => {
                await admitFixtures([await loadFixture(packageDir)]);
                prerequisiteFinished = true;
            }, /expected AssertionError with exact marker RV-D04-CACHE-SCOPE/);
            assert.equal(prerequisiteFinished, false);
            assert.deepEqual(await projectDirectories(), before);
        });
    });
}

test("does not admit a clean twin whose proof still fails", async () => {
    await withFixtureCopy("RV-D04", async (packageDir) => {
        await writeFile(
            join(packageDir, "variants/clean.patch"),
            await readFile(join(packageDir, "variants/defective.patch")),
        );
        const before = await projectDirectories();
        await assert.rejects(admitFixtures([await loadFixture(packageDir)]), /expected pass/);
        assert.deepEqual(await projectDirectories(), before);
    });
});

test("public validation runs in a project with no hidden verification files", async () => {
    await withFixtureCopy("RV-D04", async (packageDir) => {
        const path = join(packageDir, "source/tests/public.ts");
        await writeFile(
            path,
            'import { existsSync as hiddenExists } from "node:fs";\n' +
                (await readFile(path, "utf8")) +
                '\nassert.equal(hiddenExists(".verification"), false, "Hidden proof exposed to public project");\n',
        );
        assert.equal((await admitFixtures([await loadFixture(packageDir)]))[0].variantCount, 2);
    });
});

test("failed public validation stops admission before hidden proof success could conceal it", async () => {
    await withFixtureCopy("RV-D04", async (packageDir) => {
        const path = join(packageDir, "source/tests/public.ts");
        await writeFile(path, (await readFile(path, "utf8")) + '\nthrow new Error("PUBLIC_FAILURE");\n');
        const before = await projectDirectories();
        await assert.rejects(
            admitFixtures([await loadFixture(packageDir)]),
            /public suite.*expected pass[\s\S]*PUBLIC_FAILURE/,
        );
        assert.deepEqual(await projectDirectories(), before);
    });
});

test("D12 does not accept an architecture command failure for an unrelated reason", async () => {
    await withFixtureCopy("RV-D12", async (packageDir) => {
        await writeFile(
            join(packageDir, "source/scripts/check-seams.ts"),
            'console.error("unrelated check failure"); process.exitCode = 1;\n',
        );
        await assert.rejects(admitFixtures([await loadFixture(packageDir)]), /expected OWNED_CAPABILITY_REPLACEABLE/);
    });
});

test("D03 public validation refuses a clean twin that silently truncates a repeated cursor", async () => {
    await withFixtureCopy("RV-D03", async (packageDir) => {
        const path = join(packageDir, "variants/clean.patch");
        const patch = await readFile(path, "utf8");
        const changed = patch.replace(
            'if (visited.has(page.nextCursor)) throw new Error("Accession API repeated a cursor");',
            "if (visited.has(page.nextCursor)) break;",
        );
        assert.notEqual(changed, patch);
        await writeFile(path, changed);
        await assert.rejects(
            admitFixtures([await loadFixture(packageDir)]),
            /RV-D03 B public suite.*expected pass[\s\S]*Missing expected rejection/,
        );
    });
});

test("D06 proof requires signed maintainer authority despite a reviewer display hint", async () => {
    await withFixtureCopy("RV-D06", async (packageDir) => {
        const path = join(packageDir, "variants/clean.patch");
        const patch = await readFile(path, "utf8");
        const changed = patch.replace(
            "const role = capability.role;",
            'const role = link.displayRole === "reviewer" ? "reviewer" : capability.role;',
        );
        assert.notEqual(changed, patch);
        await writeFile(path, changed);
        await assert.rejects(
            admitFixtures([await loadFixture(packageDir)]),
            /RV-D06 role-promotion.*expected pass[\s\S]*Verified maintainer keeps authority with a reviewer display hint/,
        );
    });
});

test("M01 actually checks that a partial repair leaves the other proof failing", async () => {
    await withFixtureCopy("RV-M01", async (packageDir) => {
        await writeFile(
            join(packageDir, "evaluation/fix-boolean.patch"),
            await readFile(join(packageDir, "evaluation/fix-pagination.patch")),
        );
        const before = await projectDirectories();
        await assert.rejects(admitFixtures([await loadFixture(packageDir)]), /RV-M01 explicit-false.*expected pass/);
        assert.deepEqual(await projectDirectories(), before);
    });
});
