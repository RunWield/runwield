import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { load, JSON_SCHEMA } from "js-yaml";

export const FIXTURE_GROUPS: readonly string[] = [
    "plan-adherence",
    "plan-named-edge-case",
    "correctness-beyond-plan",
    "cross-file-context",
    "architecture",
    "multiple-defects",
];
export const SCENARIO_ID_PATTERN = /^RV-(?:D|M)\d{2}$/;

export type VariantId = "A" | "B";
export type ProofOutcome = "pass" | "fail";

export interface FixtureManifest {
    schemaVersion: number;
    scenarioId: string;
    group: string;
    fixtureRevision: number;
    track: string;
    language: string;
    tags: string[];
    sourcePath: string;
    planPath: string;
    baselineRef: string;
    candidateRef: string;
    timeoutMs: number;
    runtime: FixtureRuntime;
    validation: PublicValidation;
}
interface FixtureRuntime {
    name: string;
    version: string;
}
interface PublicValidation {
    publicCommand: string;
    publicExpectedOutcome: string;
    architectureCommand?: string;
}
export interface FixtureProof {
    command: string;
    expectedFailureMarker: string;
}
export interface FixtureDefect {
    defectId: string;
    severity: string;
    category: string;
    trigger: string;
    expectedBehavior: string;
    wrongBehavior: string;
    evidence: string[];
    acceptableConcepts: string[];
    proofCommand: string;
    expectedFailureMarker: string;
    additionalProofCommands?: string[];
}
export interface FixtureVariant {
    patch: string;
    patchBase: string;
    expectedDecision: "approve" | "reject";
    defects: FixtureDefect[];
    validationOutcomes?: Record<string, ProofOutcome>;
    publicFailureMarker?: string;
}
interface VerificationFiles {
    copyFiles: Record<string, string>;
    packageScripts: Record<string, string>;
}
export interface VerificationCandidate {
    patch: string;
    patchBase: string;
    expectedProofOutcomes: Record<string, ProofOutcome>;
}
export interface FixtureOracle {
    schemaVersion: number;
    scenarioId: string;
    verification: VerificationFiles;
    proofs: Record<string, FixtureProof>;
    variants: Partial<Record<VariantId, FixtureVariant>>;
    verificationOnlyCandidates?: Record<string, VerificationCandidate>;
}
export interface ReviewerFixture {
    packageDir: string;
    sourceDir: string;
    manifest: FixtureManifest;
    oracle: FixtureOracle;
}

function requireValue(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(`Invalid reviewer fixture: ${message}`);
}
function nonempty(value: string): boolean {
    return typeof value === "string" && value.trim().length > 0;
}

/** Paths use repository-relative, unquoted POSIX names. Symlinks are never admitted. */
export function containedPath(root: string, path: string): string {
    requireValue(nonempty(path), "missing path");
    requireValue(!isAbsolute(path) && !path.includes("\\") && !path.includes("\0"), `unsafe path ${path}`);
    requireValue(
        path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
        `unsafe path ${path}`,
    );
    const result = resolve(root, path);
    const rel = relative(root, result);
    requireValue(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `path escapes root: ${path}`);
    return result;
}

export async function regularFile(root: string, path: string): Promise<string> {
    const result = containedPath(root, path);
    let cursor = root;
    for (const part of path.split("/")) {
        cursor = join(cursor, part);
        const stat = await lstat(cursor);
        requireValue(!stat.isSymbolicLink(), `symlink ${path}`);
    }
    requireValue((await lstat(result)).isFile(), `not a regular file: ${path}`);
    return result;
}

export async function validateSourceTree(source: string): Promise<void> {
    requireValue(
        (await lstat(source)).isDirectory() && !(await lstat(source)).isSymbolicLink(),
        "invalid source directory",
    );
    for (const entry of await readdir(source, { withFileTypes: true })) {
        requireValue(
            ![".git", "evaluation", ".verification", ".wld"].includes(entry.name),
            `private source path ${entry.name}`,
        );
        const path = join(source, entry.name);
        if (entry.isDirectory()) await validateSourceTree(path);
        else requireValue(entry.isFile(), `non-regular source entry ${path}`);
    }
}

/** Only ordinary text-file patches are supported; Git also checks applicability before writes. */
export async function readFixturePatch(fixture: ReviewerFixture, path: string): Promise<string> {
    const patch = await readFile(await regularFile(fixture.packageDir, path), "utf8");
    const headers = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)];
    requireValue(
        headers.length > 0 && headers.length === (patch.match(/^diff --git /gm) || []).length,
        "invalid patch headers",
    );
    requireValue(
        !/^(?:old mode|new mode|new file mode|deleted file mode) (?!100644$|100755$)/m.test(patch),
        "non-regular patch mode",
    );
    requireValue(!/^index \S+ (?!(?:100644|100755)$)\S+$/m.test(patch), "non-regular patch index mode");
    requireValue(!/^(?:rename |copy |GIT binary patch|Binary files )/m.test(patch), "unsupported patch operation");
    for (const header of headers) {
        requireValue(header[1] === header[2], "patch changes path identity");
        containedPath(fixture.sourceDir, header[1]);
        requireValue(
            !header[1].split("/").some((part) => [".git", "evaluation", ".verification", ".wld"].includes(part)),
            "private patch path",
        );
    }
    for (const line of patch.split("\n")) {
        if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
        if (line === "--- /dev/null" || line === "+++ /dev/null") continue;
        const match = /^(?:--- a|\+\+\+ b)\/(\S+)$/.exec(line);
        requireValue(Boolean(match && headers.some((header) => header[1] === match[1])), "invalid patch file path");
    }
    return patch;
}

export function fixtureVariant(fixture: ReviewerFixture, variant: VariantId): FixtureVariant {
    const value = fixture.oracle.variants[variant];
    requireValue(Boolean(value), `missing variant ${variant}`);
    return value!;
}

/** Parse a corpus package and validate its public and hidden fixture contract. */
export async function loadFixture(packagePath: string): Promise<ReviewerFixture> {
    const packageDir = await realpath(packagePath);
    const manifest = load(await readFile(await regularFile(packageDir, "scenario.yaml"), "utf8"), {
        schema: JSON_SCHEMA,
    }) as FixtureManifest;
    const oracle = load(await readFile(await regularFile(packageDir, "evaluation/oracle.yaml"), "utf8"), {
        schema: JSON_SCHEMA,
    }) as FixtureOracle;
    requireValue(manifest?.schemaVersion === 1 && oracle?.schemaVersion === 1, "unsupported schema");
    requireValue(SCENARIO_ID_PATTERN.test(manifest.scenarioId), "invalid scenario ID");
    requireValue(manifest.scenarioId === basename(packageDir), "scenario directory mismatch");
    requireValue(FIXTURE_GROUPS.includes(manifest.group), "invalid coverage group");
    requireValue(oracle.scenarioId === manifest.scenarioId, "oracle scenario mismatch");
    requireValue(
        Number.isInteger(manifest.fixtureRevision) && manifest.fixtureRevision > 0,
        "invalid fixture revision",
    );
    requireValue(manifest.track === "discovery" && manifest.sourcePath === "source", "unsupported source or track");
    requireValue(manifest.language === "typescript", "unsupported language");
    requireValue(
        Array.isArray(manifest.tags) && manifest.tags.length > 0 && manifest.tags.every(nonempty),
        "missing tags",
    );
    requireValue(manifest.baselineRef === "main" && manifest.candidateRef === "change", "non-neutral refs");
    requireValue(manifest.runtime?.name === "bun" && manifest.runtime.version === "1.4.3", "unsupported runtime");
    requireValue(
        Number.isInteger(manifest.timeoutMs) && manifest.timeoutMs > 0 && manifest.timeoutMs <= 120000,
        "invalid timeout",
    );
    requireValue(
        manifest.validation?.publicCommand === "bun run test" &&
            ["pass-for-every-candidate", "declared-per-variant"].includes(manifest.validation.publicExpectedOutcome),
        "unsupported public validation",
    );
    requireValue(
        manifest.validation.architectureCommand === undefined ||
            manifest.validation.architectureCommand === "bun run seams:check",
        "unsupported architecture validation",
    );
    requireValue(
        (manifest.scenarioId === "RV-D12") === Boolean(manifest.validation.architectureCommand),
        "missing architecture validation",
    );
    const sourceDir = containedPath(packageDir, manifest.sourcePath);
    await validateSourceTree(sourceDir);
    await regularFile(sourceDir, manifest.planPath);
    const fixture: ReviewerFixture = { packageDir, sourceDir, manifest, oracle };
    requireValue(
        JSON.stringify(oracle.verification?.copyFiles) ===
            JSON.stringify({ "evaluation/proofs.ts": ".verification/proofs.ts" }),
        "unsupported verification files",
    );
    requireValue(
        JSON.stringify(oracle.verification?.packageScripts) ===
            JSON.stringify({ "test:oracle": "bun .verification/proofs.ts" }),
        "unsupported proof script",
    );
    await regularFile(packageDir, "evaluation/proofs.ts");
    requireValue(
        Boolean(oracle.proofs) && typeof oracle.proofs === "object" && !Array.isArray(oracle.proofs),
        "missing proofs",
    );
    const commands = new Map<string, FixtureProof>();
    for (const [name, proof] of Object.entries(oracle.proofs)) {
        requireValue(
            /^[a-z][a-z-]*$/.test(name) && proof?.command === `bun run test:oracle ${name}`,
            "invalid proof command",
        );
        requireValue(
            typeof proof.expectedFailureMarker === "string" && /^RV-[A-Z0-9-]+$/.test(proof.expectedFailureMarker),
            "invalid assertion marker",
        );
        commands.set(proof.command, proof);
    }
    requireValue(commands.size > 0, "empty proofs");
    requireValue(
        Boolean(oracle.variants) &&
            Object.keys(oracle.variants).sort().join(",") === (manifest.scenarioId === "RV-M01" ? "A" : "A,B"),
        "invalid variants",
    );
    const covered = new Set<string>();
    for (const id of Object.keys(oracle.variants) as VariantId[]) {
        const variant = fixtureVariant(fixture, id);
        requireValue(
            variant.patchBase === "source" && nonempty(variant.patch) && variant.patch.startsWith("variants/"),
            "invalid variant patch base",
        );
        await readFixturePatch(fixture, variant.patch);
        requireValue(variant.expectedDecision === (id === "A" ? "reject" : "approve"), "invalid decision");
        requireValue(
            Array.isArray(variant.defects) && (id === "A" ? variant.defects.length > 0 : variant.defects.length === 0),
            "invalid defects",
        );
        for (const defect of variant.defects) {
            requireValue(
                Boolean(defect) &&
                    nonempty(defect.defectId) &&
                    ["low", "medium", "high", "critical"].includes(defect.severity),
                "invalid defect identity or severity",
            );
            for (const text of [defect.category, defect.trigger, defect.expectedBehavior, defect.wrongBehavior])
                requireValue(nonempty(text), "missing defect description");
            requireValue(Array.isArray(defect.evidence) && defect.evidence.length > 0, "missing evidence");
            for (const path of defect.evidence) await regularFile(sourceDir, path);
            requireValue(
                Array.isArray(defect.acceptableConcepts) &&
                    defect.acceptableConcepts.length > 0 &&
                    defect.acceptableConcepts.every(nonempty),
                "missing concepts",
            );
            requireValue(
                defect.additionalProofCommands === undefined || Array.isArray(defect.additionalProofCommands),
                "invalid additional proofs",
            );
            for (const command of [defect.proofCommand, ...(defect.additionalProofCommands || [])]) {
                const proof = commands.get(command);
                requireValue(Boolean(proof), `undeclared proof ${command}`);
                if (command === defect.proofCommand)
                    requireValue(
                        proof!.expectedFailureMarker === defect.expectedFailureMarker,
                        "proof marker mismatch",
                    );
                covered.add(command);
            }
        }
        const declaredPublic = manifest.validation.publicExpectedOutcome === "declared-per-variant";
        if (manifest.validation.architectureCommand || declaredPublic) {
            const expectedKeys = ["bun run test"];
            requireValue(
                ["pass", "fail"].includes(variant.validationOutcomes?.["bun run test"] || "") &&
                    (declaredPublic || variant.validationOutcomes?.["bun run test"] === "pass"),
                "missing declared public outcome",
            );
            if (manifest.validation.architectureCommand) {
                expectedKeys.push("bun run seams:check");
                requireValue(
                    variant.validationOutcomes?.["bun run seams:check"] === (id === "A" ? "fail" : "pass"),
                    "missing declared validation outcomes",
                );
            }
            requireValue(
                Object.keys(variant.validationOutcomes!).sort().join(",") === expectedKeys.sort().join(","),
                "unsupported extra validation outcomes",
            );
        } else requireValue(variant.validationOutcomes === undefined, "unsupported extra validation outcomes");
        requireValue(
            id !== "B" || variant.validationOutcomes?.["bun run test"] !== "fail",
            "clean public suite must pass",
        );
        requireValue(
            variant.validationOutcomes?.["bun run test"] === "fail"
                ? nonempty(variant.publicFailureMarker!) && !/[\r\n]/.test(variant.publicFailureMarker!)
                : variant.publicFailureMarker === undefined,
            "invalid public failure marker",
        );
    }
    requireValue(covered.size === commands.size, "unowned proof");
    if (manifest.scenarioId === "RV-M01") {
        const candidates = oracle.verificationOnlyCandidates;
        requireValue(
            Boolean(candidates) && Object.keys(candidates!).sort().join(",") === "booleanRepair,clean,paginationRepair",
            "missing independence matrix",
        );
        const matrix: Record<string, string> = {
            clean: "pass,pass",
            booleanRepair: "pass,fail",
            paginationRepair: "fail,pass",
        };
        requireValue(
            Object.keys(oracle.proofs).sort().join(",") === "empty-cursor-page,explicit-false",
            "invalid independence proofs",
        );
        for (const [name, candidate] of Object.entries(candidates!)) {
            requireValue(
                candidate?.patchBase === (name === "clean" ? "source" : "A") &&
                    nonempty(candidate.patch) &&
                    candidate.patch.startsWith("evaluation/"),
                "invalid verification candidate",
            );
            requireValue(
                Object.keys(candidate.expectedProofOutcomes || {})
                    .sort()
                    .join(",") === "empty-cursor-page,explicit-false",
                "incomplete proof matrix",
            );
            requireValue(
                [
                    candidate.expectedProofOutcomes["explicit-false"],
                    candidate.expectedProofOutcomes["empty-cursor-page"],
                ].join(",") === matrix[name],
                "incorrect independence matrix",
            );
            await readFixturePatch(fixture, candidate.patch);
        }
    } else requireValue(oracle.verificationOnlyCandidates === undefined, "unexpected verification candidates");
    return fixture;
}
