import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureForegroundProcess } from "../../src/shared/captured-process.ts";
import { fixtureVariant, regularFile } from "./fixtures.ts";
import type { FixtureProof, ProofOutcome, ReviewerFixture, VariantId } from "./fixtures.ts";
import { applyFixturePatch, createProjectDirectory, materializeFixture, projectGit } from "./materialize.ts";

export interface FixtureAdmission {
    scenarioId: string;
    variantCount: number;
    publicChecks: number;
    proofChecks: number;
}
interface CheckResult {
    code: number;
    output: string;
}

// Observe the actual exception class and exact message, not matching source snippets or an unrelated crash's text.
// This file and all hidden inputs exist only in disposable verification copies.
function assertionRunner(entrypoint = "./proofs.ts"): string {
    return `import { AssertionError } from "node:assert";
try {
    await import(${JSON.stringify(entrypoint)});
} catch (error) {
    if (error instanceof AssertionError && error.code === "ERR_ASSERTION" && error.message.split("\\n")[0] === process.argv[3]) {
        console.error("EXPECTED_ASSERTION " + JSON.stringify(process.argv[3]));
        process.exitCode = 42;
    } else {
        throw error;
    }
}
`;
}

interface PublicTestPackage {
    scripts: { test: string };
}

async function runCheck(cwd: string, args: string[], timeoutMs: number): Promise<CheckResult> {
    const result = await captureForegroundProcess("bun", { cwd, args, timeoutMs });
    const decoder = new TextDecoder();
    return { code: result.code, output: decoder.decode(result.stdout) + decoder.decode(result.stderr) };
}

function requirePass(result: CheckResult, context: string): void {
    if (result.code !== 0) throw new Error(`Fixture admission failed (${context}): expected pass\n${result.output}`);
}

async function checkProof(
    cwd: string,
    fixture: ReviewerFixture,
    name: string,
    proof: FixtureProof,
    expected: ProofOutcome,
): Promise<void> {
    const result = await runCheck(
        cwd,
        [".verification/run.ts", name, proof.expectedFailureMarker],
        fixture.manifest.timeoutMs,
    );
    if (expected === "pass") {
        requirePass(result, `${fixture.manifest.scenarioId} ${name}`);
    } else if (
        result.code !== 42 ||
        !result.output.split(/\r?\n/).includes(`EXPECTED_ASSERTION ${JSON.stringify(proof.expectedFailureMarker)}`)
    ) {
        throw new Error(
            `Fixture admission failed (${fixture.manifest.scenarioId} ${name}): expected AssertionError with exact marker ${proof.expectedFailureMarker}\n${result.output}`,
        );
    }
}

async function verificationCopy(
    cwd: string,
    fixture: ReviewerFixture,
    check: (copy: string) => Promise<void>,
): Promise<void> {
    const copy = await createProjectDirectory();
    try {
        await cp(cwd, copy, { recursive: true });
        await mkdir(join(copy, ".verification"));
        await cp(await regularFile(fixture.packageDir, "evaluation/proofs.ts"), join(copy, ".verification/proofs.ts"));
        await writeFile(join(copy, ".verification/run.ts"), assertionRunner());
        await check(copy);
    } finally {
        await rm(copy, { recursive: true, force: true });
    }
}

/** Must finish before a caller creates a model session. Any failed prerequisite throws and all projects are removed. */
export async function admitFixtures(fixtures: ReviewerFixture[]): Promise<FixtureAdmission[]> {
    const admissions: FixtureAdmission[] = [];
    for (const fixture of fixtures) {
        const admission: FixtureAdmission = {
            scenarioId: fixture.manifest.scenarioId,
            variantCount: 0,
            publicChecks: 0,
            proofChecks: 0,
        };
        // Both twins are prerequisites even if the later run selects only one of them.
        for (const variant of Object.keys(fixture.oracle.variants) as VariantId[]) {
            const project = await materializeFixture(fixture, variant);
            try {
                const selected = fixtureVariant(fixture, variant);
                const publicResult = await runCheck(project.cwd, ["run", "test"], fixture.manifest.timeoutMs);
                if (selected.validationOutcomes?.["bun run test"] === "fail") {
                    const pkg = JSON.parse(
                        await readFile(join(project.cwd, "package.json"), "utf8"),
                    ) as PublicTestPackage;
                    if (pkg.scripts?.test !== "bun tests/public.ts")
                        throw new Error("Unsupported public assertion entrypoint");
                    const guard = await createProjectDirectory();
                    try {
                        const script = join(guard, "assertion.ts");
                        await writeFile(script, assertionRunner(await regularFile(project.cwd, "tests/public.ts")));
                        const assertion = await runCheck(
                            project.cwd,
                            [script, "public", selected.publicFailureMarker!],
                            fixture.manifest.timeoutMs,
                        );
                        if (
                            publicResult.code !== 1 ||
                            assertion.code !== 42 ||
                            !assertion.output
                                .split(/\r?\n/)
                                .includes(`EXPECTED_ASSERTION ${JSON.stringify(selected.publicFailureMarker)}`)
                        )
                            throw new Error(
                                `Fixture admission failed (${admission.scenarioId} ${variant} public suite): expected assertion ${selected.publicFailureMarker}\n${publicResult.output}\n${assertion.output}`,
                            );
                    } finally {
                        await rm(guard, { recursive: true, force: true });
                    }
                } else requirePass(publicResult, `${admission.scenarioId} ${variant} public suite`);
                admission.publicChecks++;
                if (fixture.manifest.validation.architectureCommand) {
                    const result = await runCheck(project.cwd, ["run", "seams:check"], fixture.manifest.timeoutMs);
                    const expected = fixtureVariant(fixture, variant).validationOutcomes!["bun run seams:check"];
                    if (expected === "pass") requirePass(result, `${admission.scenarioId} ${variant} architecture`);
                    else if (result.code !== 1 || !/^OWNED_CAPABILITY_REPLACEABLE: /m.test(result.output)) {
                        throw new Error(
                            `Fixture admission failed (${admission.scenarioId} architecture): expected OWNED_CAPABILITY_REPLACEABLE\n${result.output}`,
                        );
                    }
                    admission.publicChecks++;
                }
                await verificationCopy(project.cwd, fixture, async (copy) => {
                    for (const [name, proof] of Object.entries(fixture.oracle.proofs)) {
                        await checkProof(copy, fixture, name, proof, variant === "A" ? "fail" : "pass");
                        admission.proofChecks++;
                    }
                });
                if (variant === "A" && fixture.oracle.verificationOnlyCandidates) {
                    for (const candidate of Object.values(fixture.oracle.verificationOnlyCandidates)) {
                        await verificationCopy(project.cwd, fixture, async (copy) => {
                            if (candidate.patchBase === "source") {
                                await projectGit(copy, ["reset", "--hard", "main"]);
                                // Remove candidate-only public files, but retain the verification harness.
                                await projectGit(copy, ["clean", "-fd", "-e", ".verification/"]);
                            }
                            await applyFixturePatch(copy, fixture, candidate.patch);
                            requirePass(
                                await runCheck(copy, ["run", "test"], fixture.manifest.timeoutMs),
                                `${admission.scenarioId} verification public suite`,
                            );
                            admission.publicChecks++;
                            for (const [name, proof] of Object.entries(fixture.oracle.proofs)) {
                                await checkProof(copy, fixture, name, proof, candidate.expectedProofOutcomes[name]);
                                admission.proofChecks++;
                            }
                        });
                    }
                }
                admission.variantCount++;
            } finally {
                await project.cleanup();
            }
        }
        admissions.push(admission);
    }
    return admissions;
}
