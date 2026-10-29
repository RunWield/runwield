import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureForegroundProcess } from "../../src/shared/captured-process.ts";
import { createProjectDirectory, materializeFixture } from "./materialize.ts";
import { loadFixture } from "./fixtures.ts";
import { admitFixtures } from "./admission.ts";
import { corpusPath, withFixtureCopy } from "./test-fixtures.ts";

interface FixturePackage {
    scripts: Record<string, string>;
}

for (const variant of ["defective", "clean"]) {
    test(`cache ${variant} public coverage detects stale reads across refresh`, async () => {
        await withFixtureCopy("RV-D04", async (root) => {
            const path = join(root, `variants/${variant}.patch`);
            const patch = await readFile(path, "utf8");
            assert.ok(patch.includes("this.summaries = new Map();"));
            await writeFile(path, patch.replace("this.summaries = new Map();", "this.summaries.clear();"));
            await assert.rejects(
                admitFixtures([await loadFixture(root)]),
                /public suite.*expected pass[\s\S]*Refresh must isolate pending reads/,
            );
        });
    });
}

test("archive clean coverage detects timestamp-based membership", async () => {
    await withFixtureCopy("RV-D13", async (root) => {
        const path = join(root, "variants/clean.patch");
        const patch = await readFile(path, "utf8");
        const correct = 'const records = await listPlans(root, options.archivedOnly ? "archived" : undefined);';
        assert.ok(patch.includes(correct));
        await writeFile(
            path,
            patch.replace(
                correct,
                "const records = (await listPlans(root)).filter(record => !options.archivedOnly || record.archivedAt !== undefined);",
            ),
        );
        await assert.rejects(
            admitFixtures([await loadFixture(root)]),
            /B public suite.*expected pass[\s\S]*Archived-only listing must return archived Plans only/,
        );
    });
});

for (const statement of [
    'throw new Error("Archived-only listing must return archived Plans only");',
    'throw Object.assign(new Error("Archived-only listing must return archived Plans only"), { name: "AssertionError", code: "ERR_ASSERTION" });',
    'assert.equal(1, 2, "Wrong assertion");',
]) {
    test(`archive admission refuses an unrelated public failure: ${statement}`, async () => {
        await withFixtureCopy("RV-D13", async (root) => {
            const path = join(root, "source/tests/public.ts");
            await writeFile(path, statement + "\n" + (await readFile(path, "utf8")));
            await assert.rejects(admitFixtures([await loadFixture(root)]), /public suite.*expected assertion/);
        });
    });
}

test("archive admission refuses an unexpected public pass", async () => {
    await withFixtureCopy("RV-D13", async (root) => {
        await writeFile(join(root, "variants/defective.patch"), await readFile(join(root, "variants/clean.patch")));
        await assert.rejects(admitFixtures([await loadFixture(root)]), /A public suite.*expected assertion/);
    });
});

for (const patchPath of ["variants/defective.patch", "evaluation/clean.patch"]) {
    test(`continuation coverage in ${patchPath} detects sending a different cursor`, async () => {
        await withFixtureCopy("RV-M01", async (root) => {
            const path = join(root, patchPath);
            const patch = await readFile(path, "utf8");
            assert.ok(patch.includes("cursor = page.nextCursor;"));
            await writeFile(path, patch.replace("cursor = page.nextCursor;", 'cursor = "wrong-cursor";'));
            await assert.rejects(
                admitFixtures([await loadFixture(root)]),
                /public suite.*expected pass[\s\S]*Continuation must use the returned cursor/,
            );
        });
    });
}

test("registry oracle owns architecture and durable test coverage separately", async () => {
    const fixture = await loadFixture(join(corpusPath, "RV-D12"));
    assert.deepEqual(
        fixture.oracle.variants.A!.defects.map(({ defectId, proofCommand }) => ({ defectId, proofCommand })),
        [
            { defectId: "RV-D12-A", proofCommand: "bun run test:oracle seam-check" },
            { defectId: "RV-D12-TEST-DURABILITY", proofCommand: "bun run test:oracle mutation-coverage" },
        ],
    );
});

for (const replacement of [
    { from: "bun run test: pass", to: "bun run test: fail", error: /clean public suite must pass/ },
    { from: "bun run test: fail", to: "bun run test: missing", error: /missing declared public outcome/ },
    {
        from: "publicFailureMarker: Archived-only listing must return archived Plans only",
        to: "publicFailureMarker: ''",
        error: /invalid public failure marker/,
    },
]) {
    test(`archive fixture rejects invalid public failure metadata: ${replacement.from}`, async () => {
        await withFixtureCopy("RV-D13", async (root) => {
            const path = join(root, "evaluation/oracle.yaml");
            const original = await readFile(path, "utf8");
            assert.ok(original.includes(replacement.from));
            await writeFile(path, original.replace(replacement.from, replacement.to));
            await assert.rejects(loadFixture(root), replacement.error);
        });
    });
}

for (const repair of [
    { file: "src/register.ts", pass: "seam-check", fail: "mutation-coverage", marker: "RV-D12-MUTATION-SURVIVED" },
    { file: "tests/public.ts", pass: "mutation-coverage", fail: "seam-check", marker: "RV-D12-OWNED-SEAM" },
]) {
    test(`registry repair of ${repair.file} leaves the other concern detectable`, async () => {
        const fixture = await loadFixture(join(corpusPath, "RV-D12"));
        const original = await materializeFixture(fixture, "A");
        const clean = await materializeFixture(fixture, "B");
        const verification = await createProjectDirectory();
        try {
            await cp(original.cwd, verification, { recursive: true });
            await cp(join(clean.cwd, repair.file), join(verification, repair.file));
            await mkdir(join(verification, ".verification"));
            await cp(join(fixture.packageDir, "evaluation/proofs.ts"), join(verification, ".verification/proofs.ts"));
            const pkg = JSON.parse(await readFile(join(verification, "package.json"), "utf8")) as FixturePackage;
            pkg.scripts["test:oracle"] = "bun .verification/proofs.ts";
            await writeFile(join(verification, "package.json"), JSON.stringify(pkg));
            for (const proof of [repair.pass, repair.fail]) {
                const result = await captureForegroundProcess("bun", {
                    cwd: verification,
                    args: ["run", "test:oracle", proof],
                    timeoutMs: 10000,
                });
                const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
                assert.equal(result.code, proof === repair.pass ? 0 : 1, output);
                if (proof === repair.fail) assert.ok(output.includes(`AssertionError: ${repair.marker}`), output);
            }
        } finally {
            await rm(verification, { recursive: true, force: true });
            await clean.cleanup();
            await original.cleanup();
        }
    });
}

for (const variant of ["defective", "clean"]) {
    test(`repair ${variant} coverage detects completion delivery suppressed by the completion flag`, async () => {
        await withFixtureCopy("RV-D08", async (root) => {
            const path = join(root, `variants/${variant}.patch`);
            const patch = await readFile(path, "utf8");
            const guard =
                "if (state.notifications.includes(taskId) || state.consumers.some((entry) => entry.taskId === taskId)) return;";
            assert.ok(patch.includes(guard));
            await writeFile(
                path,
                patch.replace(guard, "if (state.tasks.find((task) => task.id === taskId)?.completed) return;"),
            );
            await assert.rejects(
                admitFixtures([await loadFixture(root)]),
                /public suite.*expected (?:pass|assertion)[\s\S]*Recorded general completion must still be delivered/,
            );
        });
    });

    test(`repair ${variant} coverage detects recorded repair delivery suppressed by the completion flag`, async () => {
        await withFixtureCopy("RV-D08", async (root) => {
            const path = join(root, `variants/${variant}.patch`);
            const patch = await readFile(path, "utf8");
            const guard =
                "if (state.notifications.includes(taskId) || state.consumers.some((entry) => entry.taskId === taskId)) return;";
            assert.ok(patch.includes(guard));
            await writeFile(
                path,
                patch.replace(
                    guard,
                    'if (state.notifications.includes(taskId) || state.consumers.some((entry) => entry.taskId === taskId) || state.tasks.some((task) => task.id === taskId && task.kind === "repair" && task.completed)) return;',
                ),
            );
            await assert.rejects(
                admitFixtures([await loadFixture(root)]),
                /public suite.*expected (?:pass|assertion)[\s\S]*Recorded repair completion must still be delivered/,
            );
        });
    });

    test(`publication ${variant} coverage detects returning a stale rejected attempt`, async () => {
        await withFixtureCopy("RV-D10", async (root) => {
            const path = join(root, `variants/${variant}.patch`);
            const patch = await readFile(path, "utf8");
            const fetch = "const target = fetchTarget(workspace, saved.remote, saved.targetRef);";
            assert.ok(patch.includes(fetch));
            // Still attempt the real retry, but return and persist its previous rejection.
            await writeFile(
                path,
                patch
                    .replace(
                        "+    return send(workspace, path, {",
                        "+    const retried = await send(workspace, path, {",
                    )
                    .replace(
                        '+        status: "pending",\n+    });\n+}',
                        '+        status: "pending",\n+    });\n+    if (retried.status === "pending") { await saveAttempt(path, saved); return saved; } return retried;\n+}',
                    )
                    .replace(/@@ -50,3 \+50,(\d+) @@/, (_, size: string) => `@@ -50,3 +50,${Number(size) + 1} @@`),
            );
            await assert.rejects(
                admitFixtures([await loadFixture(root)]),
                /public suite.*expected pass[\s\S]*Retry must record the current rejection/,
            );
        });
    });
}

test("board clean coverage detects authorization from a conflicting display hint", async () => {
    await withFixtureCopy("RV-D06", async (root) => {
        const path = join(root, "variants/clean.patch");
        const patch = await readFile(path, "utf8");
        assert.ok(patch.includes("const role = capability.role;"));
        await writeFile(path, patch.replace("const role = capability.role;", "const role = link.displayRole;"));
        await assert.rejects(
            admitFixtures([await loadFixture(root)]),
            /B public suite.*expected pass[\s\S]*Verified capability must decide rename authority/,
        );
    });
});

test("command clean coverage detects a public result published before group settlement", async () => {
    await withFixtureCopy("RV-D07", async (root) => {
        const path = join(root, "variants/clean.patch");
        const patch = await readFile(path, "utf8");
        const gate = "if (this.settlement) this.settlement.then(() => resolve(result), reject);";
        assert.ok(patch.includes(gate));
        await writeFile(
            path,
            patch.replace(gate, "if (false && this.settlement) this.settlement.then(() => resolve(result), reject);"),
        );
        await assert.rejects(
            admitFixtures([await loadFixture(root)]),
            /B public suite.*expected pass[\s\S]*Public result must wait for group settlement/,
        );
    });
});

for (const scenario of ["recorded", "live", "recovery", "owner"]) {
    test(`repair public coverage detects incorrect ${scenario} consumption`, async () => {
        const fixture = await loadFixture(join(corpusPath, "RV-D08"));
        const project = await materializeFixture(fixture, scenario === "recorded" ? "A" : "B");
        try {
            if (scenario !== "recorded") {
                const path = join(project.cwd, "src/service.ts");
                const source = await readFile(path, "utf8");
                const correct =
                    scenario === "recovery"
                        ? 'if (task?.completed) await this.validation.consume({ taskId: task.id }, "validation");'
                        : 'if (task.kind === "repair") await this.validation.consume({ taskId }, "validation");';
                const mutated =
                    scenario === "recovery"
                        ? 'if (task?.completed) { await this.validation.consume({ taskId: task.id }, "validation"); await this.validation.consume({ taskId: task.id }, "validation"); }'
                        : scenario === "owner"
                          ? 'if (task.kind === "repair") await this.validation.consume({ taskId }, "listener");'
                          : 'if (task.kind === "repair") { await this.validation.consume({ taskId }, "validation"); if (taskId === "repair-1") await this.validation.consume({ taskId }, "validation"); }';
                assert.ok(source.includes(correct));
                await writeFile(path, source.replace(correct, mutated));
            }
            const result = await captureForegroundProcess("bun", {
                cwd: project.cwd,
                args: ["run", "test"],
                timeoutMs: 10000,
            });
            const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
            assert.equal(result.code, 1, output);
            const message = scenario === "live" ? "Live" : scenario === "recovery" ? "Recovered" : "Recorded";
            assert.ok(
                output.includes(`AssertionError: ${message} repair must have one validation-owned consumption`),
                output,
            );
        } finally {
            await project.cleanup();
        }
    });
}

for (const [taskId, label] of [
    ["recorded-repair", "Recorded"],
    ["repair-1", "Live"],
    ["repair-2", "Recovered"],
]) {
    test(`repair public coverage detects duplicate ${label.toLowerCase()} transitions`, async () => {
        const fixture = await loadFixture(join(corpusPath, "RV-D08"));
        const project = await materializeFixture(fixture, "B");
        try {
            const path = join(project.cwd, "src/validation.ts");
            const source = await readFile(path, "utf8");
            const transition = 'state.transitions.push("repairing->checking");';
            assert.ok(source.includes(transition));
            await writeFile(
                path,
                source.replace(transition, `${transition}\n        if (event.taskId === "${taskId}") ${transition}`),
            );
            const result = await captureForegroundProcess("bun", {
                cwd: project.cwd,
                args: ["run", "test"],
                timeoutMs: 10000,
            });
            const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
            assert.equal(result.code, 1, output);
            assert.ok(output.includes(`AssertionError: ${label} repair must add one transition`), output);
        } finally {
            await project.cleanup();
        }
    });
}
