/** Exact private qualifications. No test suffix or directory grants access to persistence.
 * New private imports require a reviewed entry; consumer actions must use the public owner.
 */
export const PLAN_STORE_QUALIFICATIONS: Readonly<Record<string, { reason: string; modules: readonly string[] }>> = {
    "src/cmd/load-plan/missing-directory-recovery.integration.test.ts": {
        reason: "Compare exact imported package bytes before/after public missing-checkout recovery, including deliberately replaced registry identity.",
        modules: ["src/plan-store/packages.ts"],
    },
    "src/cmd/plans/doctor.test.ts": {
        reason: "Arrange a real transition interrupted after its registry effect; assert public doctor reconciles the journal without changing the attempt.",
        modules: ["src/plan-store/transitions.ts"],
    },
    "src/plan-package-concurrency.test.ts": {
        reason: "Qualify catalog consistency and cross-process package generations under real native locks.",
        modules: ["src/plan-store/packages.ts"],
    },
    "src/plan-package-import-evidence.test.ts": {
        reason: "Qualify retained import provenance, identity/name changes and historical controller evidence.",
        modules: ["src/plan-store/packages.ts", "src/plan-store/retained-source.ts"],
    },
    "src/plan-package-import-recovery.test.ts": {
        reason: "Interrupt and recover staged import batches; inspect immutable sources and partially published members.",
        modules: ["src/plan-store/packages.ts"],
    },
    "src/plan-package-import.test.ts": {
        reason: "Qualify the private durable batch importer across source formats, names and relationships.",
        modules: ["src/plan-store/packages.ts"],
    },
    "src/plan-package-recovery.test.ts": {
        reason: "Poison package metadata/intents and verify private recovery refuses unsafe or inconsistent state.",
        modules: ["src/plan-store/packages.ts"],
    },
    "src/plan-package-snapshots.test.ts": {
        reason: "Qualify complete immutable input capture and crash recovery independently of workflow presentation.",
        modules: ["src/plan-store/packages.ts"],
    },
    "src/plan-package-store.test.ts": {
        reason: "Qualify low-level durable package create/CAS/rename/archive/resource semantics.",
        modules: ["src/plan-store.js", "src/plan-store/packages.ts"],
    },
    "src/plan-store-archive-preparation.test.ts": {
        reason: "Qualify owner-private archived metadata and retained source preparation.",
        modules: ["src/plan-store.js"],
    },
    "src/plan-store-locks.test.ts": {
        reason: "Qualify real catalog and Plan lock contention, stale holders and reentrancy.",
        modules: ["src/plan-store.js"],
    },
    "src/plan-store-passive-reads.test.ts": {
        reason: "Qualify private controller diagnostics and retained reads without preparation or filesystem mutation.",
        modules: ["src/plan-store.js", "src/plan-store/controllers.ts"],
    },
    "src/plan-store.test.js": {
        reason: "Legacy owner unit qualification for parsing, journaled writes, identity, locks and archive persistence.",
        modules: ["src/plan-store.js", "src/plan-store/controllers.ts"],
    },
    "src/shared/attached/document-host-fixture.ts": {
        reason: "Separate-process MCP fixture admits a known real package and checks durable host-read evidence.",
        modules: ["src/plan-store/packages.ts", "src/plan-store/workflows.ts"],
    },
    "src/shared/attached/execution-consent.test.ts": {
        reason: "Inject an applying execution journal after a real consent/start operation to qualify lost-write reconciliation.",
        modules: ["src/plan-store/workflows.ts"],
    },
    "src/shared/epic-artifacts.test.ts": {
        reason: "Owner unit qualification for retained Epic artifact paths, archive moves and collision behavior.",
        modules: ["src/plan-store/artifacts.ts"],
    },
    "src/shared/local-home-store.integration.test.ts": {
        reason: "Only archived metadata helper is private; author/import/archive/restore journeys exercise public commands.",
        modules: ["src/plan-store.js"],
    },
    "src/shared/testing/plan-controller-fixture.ts": {
        reason: "Arrange historical controller facts separately from prose for canonical versus retained fixture states.",
        modules: ["src/plan-store/access.ts"],
    },
    "src/shared/testing/plan-package-fixture.ts": {
        reason: "Create and inspect real durable package fixture generations; no replacement store or injected writes.",
        modules: ["src/plan-store/packages.ts"],
    },
    "src/shared/testing/plan-package-process-driver.ts": {
        reason: "Cross-process owner qualification for package contention, crash points, input capture and recovery.",
        modules: ["src/plan-store/packages.ts", "src/plan-store/workflows.ts"],
    },
    "src/shared/testing/plan-state-fixture.ts": {
        reason: "Arrange historical/interrupted states and observe controllers/journals for consumer tests; never production API.",
        modules: [
            "src/plan-store.js",
            "src/plan-store/controllers.ts",
            "src/plan-store/packages.ts",
            "src/plan-store/transitions.ts",
            "src/plan-store/workflows.ts",
        ],
    },
    "src/shared/testing/retained-plan-fixture.ts": {
        reason: "Explicitly select an existing legacy owner for retained-source qualification; public cutover is tested separately.",
        modules: ["src/plan-store/retained-source.ts"],
    },
    "src/shared/workflow/controller-registry.integration.test.ts": {
        reason: "Owner qualification for controller/registry authority, interrupted migration and execution document binding.",
        modules: ["src/plan-store.js", "src/plan-store/controllers.ts", "src/plan-store/transitions.ts"],
    },
    "src/shared/workflow/epic-review-context.test.ts": {
        reason: "Direct unit tests of private Integration Notes formatting; context reads and persistence use public operations.",
        modules: ["src/plan-store/epic-context.ts"],
    },
    "src/shared/workflow/package-authoring.integration.test.ts": {
        reason: "Interrupt owner authoring batches and inspect generation recovery and manifest completeness.",
        modules: ["src/plan-store/packages.ts"],
    },
    "src/shared/workflow/package-execution.integration.test.ts": {
        reason: "Owner execution qualification inspects frozen documents and arranges stale definitions for dispatch refusal.",
        modules: ["src/plan-store/packages.ts", "src/plan-store/workflows.ts"],
    },
    "src/shared/workflow/package-generated-artifact.test.ts": {
        reason: "Owner generated-artifact qualification inspects immutable input and generated QA recovery without source fallback.",
        modules: ["src/plan-store/workflows.ts"],
    },
    "src/shared/workflow/package-lifecycle-recovery.test.ts": {
        reason: "Poison/recover lifecycle journals and qualify the private retained-source continuation boundary.",
        modules: ["src/plan-store/packages.ts", "src/plan-store/retained-source.ts", "src/plan-store/workflows.ts"],
    },
    "src/shared/workflow/package-lifecycle.integration.test.ts": {
        reason: "Owner lifecycle qualification for immutable review/readiness input, rename and execution artifact invariants.",
        modules: ["src/plan-store/packages.ts", "src/plan-store/workflows.ts"],
    },
    "src/shared/workflow/package-project.integration.test.ts": {
        reason: "Owner admission qualification for nested Project/Plan scopes and identity isolation.",
        modules: ["src/plan-store/packages.ts", "src/plan-store/workflows.ts"],
    },
    "src/shared/workflow/package-publication-copies.test.ts": {
        reason: "Owner copy qualification inspects retained manifests and deliberately changes copy ownership/bytes.",
        modules: ["src/plan-store/packages.ts"],
    },
    "src/shared/workflow/package-publication-refusal.test.ts": {
        reason: "Arrange conflicting package ownership/candidate metadata and assert publication refusal without losing proof.",
        modules: ["src/plan-store/packages.ts", "src/plan-store/workflows.ts"],
    },
    "src/shared/workflow/package-publication-validation-recovery.test.ts": {
        reason: "Inspect durable package publication proof across failed validation and recovery.",
        modules: ["src/plan-store/packages.ts"],
    },
    "src/shared/workflow/package-publication.integration.test.ts": {
        reason: "Owner publication qualification inspects exact package receipts through real Git effects and resume.",
        modules: ["src/plan-store/packages.ts", "src/plan-store/workflows.ts"],
    },
    "src/shared/workflow/package-session-validation.test.ts": {
        reason: "Owner/Session composition qualification carries a recorded immutable package input through validation.",
        modules: ["src/plan-store/workflows.ts"],
    },
    "src/shared/workflow/package-work-record-delivery.integration.test.ts": {
        reason: "Inspect sealed package evidence across real delivery and Recorder handoff.",
        modules: ["src/plan-store/packages.ts", "src/plan-store/workflows.ts"],
    },
    "src/shared/workflow/package-work-record-recovery.test.ts": {
        reason: "Inspect durable publication manifests across interrupted Work Record copy/recording recovery.",
        modules: ["src/plan-store/packages.ts"],
    },
    "src/shared/workflow/state-transition.test.js": {
        reason: "Owner unit qualification for transition lock sets, revisions, compensation and interrupted effects.",
        modules: ["src/plan-store.js", "src/plan-store/transitions.ts"],
    },
    "src/shared/workflow/testing/package-publication-boundaries.ts": {
        reason: "Publication fault-process fixture reads exact immutable manifests at retained crash boundaries.",
        modules: ["src/plan-store/packages.ts"],
    },
    "src/shared/workflow/testing/package-publication-fixture.ts": {
        reason: "Real Git/package publication fixture creates approved attempts and captures process continuation state.",
        modules: ["src/plan-store/packages.ts", "src/plan-store/workflows.ts"],
    },
    "src/shared/workflow/testing/package-recording-process.ts": {
        reason: "Restart-process fixture resumes a recorded admission and observes real Recorder settlement.",
        modules: ["src/plan-store/packages.ts", "src/plan-store/workflows.ts"],
    },
    "src/shared/workflow/testing/package-source-process.ts": {
        reason: "Restart-process fixture reads sealed delivery sources and resumes failed Recorder work.",
        modules: ["src/plan-store/packages.ts", "src/plan-store/workflows.ts"],
    },
    "src/shared/workflow/testing/publication-process-driver.ts": {
        reason: "Cross-process publication crash driver binds real package admission and native Plan lock evidence.",
        modules: ["src/plan-store/packages.ts", "src/plan-store/workflows.ts"],
    },
    "src/shared/workflow/testing/validation-host-fixture.ts": {
        reason: "Real validation fixture observes private controller/package evidence around external host turns.",
        modules: ["src/plan-store/workflows.ts"],
    },
    "src/shared/workflow/validation-test-helpers.js": {
        reason: "Arrange real executed Plans and historical checkpoints for validation qualification; no fake Plan store.",
        modules: ["src/plan-store.js"],
    },
    "src/shared/workflow/workflow-transition-attribution.test.ts": {
        reason: "Owner unit qualification proves each named semantic transition attributes journal writes to its operation.",
        modules: ["src/plan-store/transitions.ts"],
    },
    "src/testing/usage-export-journey-workflows.ts": {
        reason: "Golden usage fixture prepares a real lifecycle transition before the public workflow journey.",
        modules: ["src/plan-store/transitions.ts"],
    },
    "src/ui/tui/testing/published-plan-fixture.ts": {
        reason: "Golden fixture selects retained versus canonical historical delivery evidence before public presentation.",
        modules: ["src/plan-store/access.ts", "src/plan-store/workflows.ts"],
    },
    "src/ui/tui/testing/scenario-runner.js": {
        reason: "Golden fixture seeds lifecycle states and inspects persisted metadata for terminal scenario assertions.",
        modules: ["src/plan-store.js", "src/plan-store/access.ts", "src/plan-store/packages.ts"],
    },
    "src/ui/workspace/package-surface-qa.ts": {
        reason: "Disposable headed-browser launcher creates real packages, stale checkout copies and malformed-package fixtures.",
        modules: ["src/plan-store/packages.ts", "src/plan-store/workflows.ts"],
    },
};

/** Test-only targets include dependent fixtures, process and Golden qualification drivers. */
export const PLAN_TEST_SUPPORT = new Set([
    "src/cmd/load-plan/publication-cleanup-test-helpers.ts",
    "src/shared/attached/attached-test-fixture.ts",
    "src/shared/attached/delivery-recovery-test-fixture.ts",
    "src/shared/attached/delivery-test-fixture.ts",
    "src/shared/attached/document-host-fixture.ts",
    "src/shared/attached/execution-test-fixture.ts",
    "src/shared/attached/review-chat-test-fixture.ts",
    "src/shared/attached/validation-test-fixture.ts",
    "src/shared/remote/remote-runtime-effects-client.ts",
    "src/shared/remote/remote-runtime-workflows-fixture.ts",
    "src/shared/remote/verify-remote-reviews.ts",
    "src/shared/remote/verify-remote-workflows.ts",
    "src/shared/testing/plan-controller-fixture.ts",
    "src/shared/testing/plan-package-fixture.ts",
    "src/shared/testing/plan-package-process-driver.ts",
    "src/shared/testing/plan-state-fixture.ts",
    "src/shared/testing/ready-plan-fixture.ts",
    "src/shared/testing/retained-plan-fixture.ts",
    "src/shared/workflow/epic-integration-test-fixture.ts",
    "src/shared/workflow/testing/controller-process-reader.ts",
    "src/shared/workflow/testing/package-publication-boundaries.ts",
    "src/shared/workflow/testing/package-publication-fixture.ts",
    "src/shared/workflow/testing/package-publication-process.ts",
    "src/shared/workflow/testing/package-recording-fixture.ts",
    "src/shared/workflow/testing/package-recording-process.ts",
    "src/shared/workflow/testing/package-source-process.ts",
    "src/shared/workflow/testing/plan-document-writer.ts",
    "src/shared/workflow/testing/publication-outcome-fixture.ts",
    "src/shared/workflow/testing/publication-outcome-process-driver.ts",
    "src/shared/workflow/testing/publication-process-driver.ts",
    "src/shared/workflow/testing/validation-host-fixture.ts",
    "src/shared/workflow/validation-test-helpers.js",
    "src/testing/usage-export-journey-workflows.ts",
    "src/testing/validation-session-script.ts",
    "src/ui/tui/golden-scenarios/catalog.ts",
    "src/ui/tui/golden-scenarios/concurrent-workflow.ts",
    "src/ui/tui/golden-scenarios/initial-scenarios.js",
    "src/ui/tui/golden-scenarios/load-plan-epic-workflow.ts",
    "src/ui/tui/golden-scenarios/load-plan-workflow.ts",
    "src/ui/tui/golden-scenarios/planned-change-workflow.js",
    "src/ui/tui/golden-scenarios/presentation-and-terminal.ts",
    "src/ui/tui/golden-scenarios/project-routing-workflow.ts",
    "src/ui/tui/golden-scenarios/project-workflow.js",
    "src/ui/tui/golden-scenarios/role-journeys.ts",
    "src/ui/tui/golden-scenarios/session-resume-workflow.ts",
    "src/ui/tui/golden-scenarios/slash-command-test-runner.ts",
    "src/ui/tui/golden-scenarios/slash-command-tree-auth.ts",
    "src/ui/tui/golden-scenarios/slash-command-tree-configuration.ts",
    "src/ui/tui/golden-scenarios/slash-command-tree-lifecycle.ts",
    "src/ui/tui/golden-scenarios/slash-command-tree-session.ts",
    "src/ui/tui/golden-scenarios/slash-command-tree-terminal.ts",
    "src/ui/tui/golden-scenarios/slash-command-tree-utility.ts",
    "src/ui/tui/golden-scenarios/validation-command-persistence.ts",
    "src/ui/tui/golden-scenarios/validation-workflow-test-runner.ts",
    "src/ui/tui/golden-scenarios/validation-workflow-tree-human-review.ts",
    "src/ui/tui/golden-scenarios/validation-workflow-tree-lifecycle.ts",
    "src/ui/tui/golden-scenarios/validation-workflow-tree-mechanical.ts",
    "src/ui/tui/golden-scenarios/validation-workflow-tree-semantic.ts",
    "src/ui/tui/golden-scenarios/validation-workflow-tree.ts",
    "src/ui/tui/testing/child-protocol.js",
    "src/ui/tui/testing/coverage-matrix.ts",
    "src/ui/tui/testing/mod.ts",
    "src/ui/tui/testing/portfolio-assertions.js",
    "src/ui/tui/testing/published-plan-fixture.ts",
    "src/ui/tui/testing/scenario-runner.js",
    "src/ui/tui/testing/shared-environment-child.ts",
    "src/ui/workspace/package-surface-qa.ts",
]);
