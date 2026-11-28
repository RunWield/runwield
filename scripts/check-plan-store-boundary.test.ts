import { test } from "node:test";
import { equal } from "node:assert/strict";
import {
    inspectPlanStoreImports,
    inspectPlanFormatGraph,
    inspectPlanFilesystemAccess,
} from "./check-plan-store-boundary.ts";

test("Plan boundary catches static imports, reexports, type queries and constructed dynamic imports", () => {
    const cases = [
        'import { readPlanPackage as hidden } from "@runwield/plans/package-storage";',
        'import { openShareAttemptJournal } from "@runwield/plans/share-attempt-journal";',
        'import { projectPlanDocuments } from "@runwield/plans/project-plan-documents";',
        'export * from "../plan-store/workflows.ts";',
        'type Hidden = import("@runwield/plans/package-storage").LoadedPlanPackage;',
        'await import("@runwield/plans/package-storage");',
        'require("../plan-store.js");',
        'const base = "@runwield/plans/"; await import(`${base}package-storage`);',
        'const target = "@runwield/plans/" + "package-storage"; await import(target);',
        'export { readPlanPackage as publicRead } from "@runwield/plans/package-storage";',
    ];
    for (const source of cases) equal(inspectPlanStoreImports("src/tools/example.ts", source).length, 1, source);
});

test("Plan boundary permits public operations, pure formatting and explicit private owner membership", () => {
    equal(
        inspectPlanStoreImports(
            "src/tools/example.ts",
            'import { openProjectPlanStore } from "../plan-store/index.ts";',
        ).length,
        0,
    );
    equal(
        inspectPlanStoreImports(
            "src/tools/example.ts",
            'import type { ProjectPlanStore } from "@runwield/plans/store";',
        ).length,
        0,
    );
    equal(
        inspectPlanStoreImports(
            "src/tools/example.ts",
            'import { parsePlanFrontMatter } from "@runwield/plans/format";',
        ).length,
        0,
    );
    equal(
        inspectPlanStoreImports("src/plan-store/events.ts", 'import { updatePlanFrontMatter } from "../plan-store.js";')
            .length,
        0,
    );
    equal(
        inspectPlanStoreImports("src/tools/example.ts", 'export * from "../shared/workflow/execution-plan-file.js";')
            .length,
        1,
    );
});

test("direct lifecycle writes cannot be reexported through the Plan store", () => {
    const surface = "src/plan-store/index.ts";
    equal(inspectPlanStoreImports(surface, 'export { archivePlan as archive } from "./queries.ts";').length, 1);
    equal(inspectPlanStoreImports(surface, 'export * from "./queries.ts";').length, 1);
    equal(inspectPlanStoreImports(surface, 'export { recordPlanEvent } from "./events.ts";').length, 1);
    equal(
        inspectPlanStoreImports(surface, 'export { serializePlanReviewVersion } from "./lifecycle-review.ts";').length,
        1,
    );
    equal(
        inspectPlanStoreImports(surface, 'export { applyAttachedPlanReview } from "./project-lifecycle.ts";').length,
        1,
    );
    equal(inspectPlanStoreImports(surface, 'export { listPlanDocuments } from "./queries.ts";').length, 0);
    equal(
        inspectPlanStoreImports(surface, 'export { openProjectPlanLifecycle } from "./project-lifecycle.ts";').length,
        0,
    );
});

test("the Plan facade rejects aliased or private owner exports", () => {
    const facade = "src/plan-store/index.ts";
    const forbidden = [
        'import { recordPlanEvent as event } from "./events.ts"; export { event as write };',
        'export { applyWorkflowPlanEvent as event } from "./project-lifecycle.ts";',
        'export { archiveSavedPlan as archive } from "./archiving.ts";',
        'export { archivePlanPackage } from "@runwield/plans/package-storage";',
        'export { restorePlanPackage } from "@runwield/plans/package-storage";',
        'export { archivePlanPackage as archive } from "@runwield/plans/package-storage";',
        'export { restorePlanPackage as restore } from "../../packages/plans/package-storage.ts";',
        'export { RetainedPlanReviewVersions as Retained } from "@runwield/plans/live-review";',
        'export type { SerializedPlanReviewVersion as Token } from "@runwield/plans/live-review";',
        'import type { SerializedPlanReviewVersion as Token } from "@runwield/plans/live-review"; export type { Token };',
        'export * as review from "@runwield/plans/live-review";',
        'export const driver = await import("@runwield/plans/live-review");',
    ];
    for (const source of forbidden) equal(inspectPlanStoreImports(facade, source).length > 0, true, source);
    equal(
        inspectPlanStoreImports(
            "src/cmd/load-plan/plan-hold.ts",
            'import { applyWorkflowPlanEvent as apply } from "../../plan-store/project-lifecycle.ts";',
        ).length,
        1,
    );
});

test("only the Plan store can use its filesystem drivers and retained evidence", () => {
    for (const entry of [
        "file-snapshots",
        "artifact-files",
        "publication-files",
        "project-plan-files",
        "package-storage",
        "operation-receipts",
    ]) {
        const source = `import * as driver from "@runwield/plans/${entry}";`;
        equal(inspectPlanStoreImports("packages/plans/package-storage.ts", source).length, 0, entry);
        equal(inspectPlanStoreImports("src/tools/example.ts", source).length, 1, entry);
        equal(inspectPlanStoreImports("packages/plans/index.ts", source).length, 1, entry);
    }
});

test("SSH authoring is limited to its host and local adapters import only their named helpers", () => {
    const entry = "@runwield/plans/project-plan-authoring";
    const host = 'import { projectPlanAuthoring as authoring } from "' + entry + '";';
    const hostFile = "src/plan-store/project-service.ts";
    const localFile = "src/plan-store/access.ts";
    equal(inspectPlanStoreImports(hostFile, host).length, 0);
    equal(inspectPlanStoreImports(localFile, host).length, 1);
    equal(inspectPlanStoreImports("src/plan-store/documents.ts", host).length, 1);
    const local = 'import { saveCanonicalPlan, type CanonicalPlanWrite } from "' + entry + '";';
    equal(inspectPlanStoreImports(localFile, local).length, 0);
    equal(inspectPlanStoreImports(hostFile, local).length, 1);
    equal(inspectPlanStoreImports(hostFile, 'await import("' + entry + '");').length, 1);
    equal(inspectPlanStoreImports("packages/plans/index.ts", 'export * from "./project-plan-authoring.ts";').length, 1);
});

test("the retained execution reader stays private to the Plan owner and independent of the application", () => {
    for (const module of ["retained-execution", "checkout-controller", "execution-git-snapshot"]) {
        const reader = `packages/plans/${module}.ts`;
        const relativeImport = `await import("../../${reader}");`;
        equal(inspectPlanStoreImports("src/plan-store/legacy.ts", relativeImport).length, 0, module);
        equal(inspectPlanStoreImports("src/tools/example.ts", relativeImport).length, 1, module);
        equal(inspectPlanStoreImports("src/tools/example.test.ts", relativeImport).length, 1, module);
        equal(inspectPlanStoreImports(reader, 'import "../../src/plan-store/index.ts";').length, 1, module);
        const graph = new Map([["packages/plans/index.ts", `export * from "./${module}.ts";`]]);
        equal(inspectPlanFormatGraph(graph).length, 1, module);
    }
});

test("tests in the Plan owner directory require exact driver qualification", () => {
    const specifier = 'await import("@runwield/plans/package-storage");';
    equal(inspectPlanStoreImports("src/plan-store/unqualified.test.ts", specifier).length, 1);
    equal(inspectPlanStoreImports("src/plan-store/unqualified.integration.ts", specifier).length, 1);
    equal(inspectPlanStoreImports("src/plan-store/testing/unqualified.ts", specifier).length, 1);
    equal(inspectPlanStoreImports("src/plan-store/operations.test.ts", specifier).length, 0);
});

test("only collaboration operations and qualified fixtures can import the shared Plan lock bypass", () => {
    const entry = "@runwield/plans/collaboration-lock";
    const bypass = `import { COLLABORATION_LOCK_BYPASS as bypass } from "${entry}";`;
    const check = `import { assertSharedPlanWriteAllowed } from "${entry}";`;
    const review = "src/ui/review/plan-review.ts";
    const workspace = "src/ui/workspace/server/plan-adapter.ts";
    const share = "src/plan-store/collaboration/share.ts";
    equal(inspectPlanStoreImports(share, bypass).length, 0);
    equal(inspectPlanStoreImports("src/cmd/plans/collaboration-commands.integration.test.ts", bypass).length, 0);
    equal(inspectPlanStoreImports("packages/plans/collaboration-lock.test.ts", check).length, 0);
    equal(inspectPlanStoreImports("src/plan-store/access.ts", check).length, 0);
    equal(inspectPlanStoreImports("packages/plans/project-plan-files.ts", check).length, 0);
    equal(inspectPlanStoreImports(review, check).length, 0);
    equal(
        inspectPlanStoreImports(
            workspace,
            `import { isSharedPlanLocked, SHARED_PLAN_LOCK_REPAIR, SharedPlanLockError } from "${entry}";`,
        ).length,
        0,
    );
    for (const file of [
        review,
        workspace,
        "src/plan-store/access.ts",
        "src/plan-store/collaboration/sharing.ts",
        "src/plan-store/unqualified.test.ts",
        "src/tools/example.ts",
        "packages/plans/collaboration-lock.test.ts",
        "packages/plans/project-plan-files.ts",
    ]) {
        equal(inspectPlanStoreImports(file, bypass).length, 1, file);
    }
    equal(inspectPlanStoreImports("src/tools/example.ts", check).length, 1);
    for (const source of [
        `import * as lock from "${entry}";`,
        `await import("${entry}");`,
        `export { COLLABORATION_LOCK_BYPASS } from "${entry}";`,
        'export * from "../../../packages/plans/collaboration-lock.ts";',
    ]) {
        equal(inspectPlanStoreImports(review, source).length, 1, source);
        equal(inspectPlanStoreImports(share, source).length, 1, source);
    }
});

test("the public Project Plan store excludes driver values", async () => {
    const file = "packages/plans/store.ts";
    for (const source of [
        'export * from "./package-storage.ts";',
        'export { PlanNotFoundError } from "./package-storage.ts";',
        'export { StalePlanWriteError as PlanNotFoundError } from "./store-errors.ts";',
        'export { readPlanPackage as openProjectPlanStore } from "./package-storage.ts";',
        'import { readPlanPackage } from "./package-storage.ts"; export { readPlanPackage };',
    ]) {
        equal(inspectPlanStoreImports(file, source).length, 1, source);
    }
    equal(inspectPlanStoreImports(file, 'export type { PackageWorkflowInput } from "./package-storage.ts";').length, 0);
    const errors = 'export { PlanNotFoundError, StalePlanWriteError } from "./store-errors.ts";';
    equal(inspectPlanStoreImports(file, errors).length, 0);
    const store = await import("@runwield/plans/store");
    equal(Object.keys(store).sort().join(","), "PlanNotFoundError,StalePlanWriteError");
    equal("PlanNotFoundError" in (await import("@runwield/plans")), false);
});

test("only the Plan store can bind a Project's Plan owner", () => {
    const source = 'import { projectPlanStoreBinding } from "@runwield/plans/project-store-binding";';
    equal(inspectPlanStoreImports("src/plan-store/project-binding.ts", source).length, 0);
    equal(inspectPlanStoreImports("src/tools/example.ts", source).length, 1);
    const rawManagedBinding =
        'import { captureManagedCheckoutBinding } from "../../packages/plans/managed-project-binding.ts";';
    equal(inspectPlanStoreImports("src/tools/example.ts", rawManagedBinding).length, 1);
});

test("only the managed SSH bootstrap can configure the Plan store connection", () => {
    const paths = [
        'await import("@runwield/plans/managed-store-host");',
        'export * from "../../packages/plans/managed-store-host.ts";',
        'import("@runwield/plans/managed-project-connection");',
        'import("@runwield/plans/managed-operation");',
        'import("../shared/remote/managed-project-owner.ts");',
    ];
    for (const source of paths) {
        equal(inspectPlanStoreImports("src/tools/example.ts", source).length, 1, source);
        equal(inspectPlanStoreImports("src/cmd/example.ts", source).length, 1, source);
    }
    const setup = 'import { configureManagedPlanStore } from "@runwield/plans/managed-store-host";';
    equal(inspectPlanStoreImports("src/shared/remote/managed-project-owner.ts", setup).length, 0);
    equal(inspectPlanStoreImports("src/shared/remote/managed-project-owner.ts", paths[0]).length, 1);
    equal(inspectPlanStoreImports("src/plan-store/managed.ts", paths[0]).length, 1);
    equal(inspectPlanStoreImports("src/plan-store/managed.ts", paths[2]).length, 0);
});

test("only the authenticated Project service can supply recovery evidence for a managed Plan", () => {
    const host = "@runwield/plans/managed-store-host";
    const service = "src/plan-store/project-service.ts";
    const recover = `import { withManagedExecutionRecovery } from "${host}";`;
    const adopt = `import { adoptManagedExecutionReplacement } from "${host}";`;
    equal(inspectPlanStoreImports(service, recover).length, 0);
    equal(inspectPlanStoreImports(service, adopt).length, 0);
    equal(
        inspectPlanStoreImports(
            service,
            `import { withManagedExecutionRecovery, adoptManagedExecutionReplacement } from "${host}";`,
        ).length,
        0,
    );
    for (const file of [
        "src/shared/remote/managed-project-owner.ts",
        "src/plan-store/managed.ts",
        "src/tools/example.ts",
        "packages/plans/index.ts",
    ]) {
        equal(inspectPlanStoreImports(file, recover).length, 1, file);
        equal(inspectPlanStoreImports(file, adopt).length, 1, file);
    }
    for (const source of [
        `import { configureManagedPlanStore as recover } from "${host}";`,
        `import { withManagedExecutionRecovery, configureManagedPlanStore } from "${host}";`,
        `import * as managed from "${host}";`,
        `const managed = await import("${host}");`,
        `export { withManagedExecutionRecovery } from "${host}";`,
        'import { withManagedExecutionRecovery } from "../../packages/plans/execution-recovery.ts";',
        'import { adoptManagedExecutionReplacement } from "../../packages/plans/managed-execution-adoption.ts";',
    ]) {
        equal(inspectPlanStoreImports(service, source).length, 1, source);
    }
});

test("the managed Plan driver cannot access connection configuration", async () => {
    const driver = await import("@runwield/plans/managed-project-connection");
    equal("configureManagedPlanStore" in driver, false);
    const privateState = 'import * as connection from "../../packages/plans/managed-project-connection-state.ts";';
    for (const source of [
        privateState,
        'import { configureManagedPlanStore } from "../../packages/plans/managed-project-connection-state.ts";',
        'await import("@runwield/plans/managed-project-connection-state");',
        'import * as host from "@runwield/plans/managed-store-host";',
    ]) {
        equal(inspectPlanStoreImports("src/plan-store/managed.ts", source).length, 1, source);
    }
    const state = 'export { configureManagedPlanStore } from "./managed-project-connection-state.ts";';
    equal(inspectPlanStoreImports("packages/plans/managed-store-host.ts", state).length, 0);
    equal(inspectPlanStoreImports("packages/plans/managed-operation.ts", state).length, 1);
    equal(inspectPlanStoreImports("packages/plans/managed-project-connection.ts", state).length, 1);
    const stateNamespace = 'export * from "./managed-project-connection-state.ts";';
    equal(inspectPlanStoreImports("packages/plans/managed-project-connection.ts", stateNamespace).length, 1);
    equal(inspectPlanStoreImports("packages/plans/managed-store-host.ts", stateNamespace).length, 1);
    const driverReads = 'export { managedExecutionRoot } from "./managed-project-connection-state.ts";';
    equal(inspectPlanStoreImports("packages/plans/managed-project-connection.ts", driverReads).length, 0);
});

test("only Plan owners and exact qualifications can select the retained checkout", () => {
    const entry = "@runwield/plans/retained-checkout";
    for (const source of [
        `import { withRetainedCheckoutSource } from "${entry}";`,
        `const retained = await import("${entry}");`,
        `const retainedUrl = import.meta.resolve("${entry}");`,
        'export * from "../../packages/plans/retained-checkout.ts";',
    ]) {
        equal(inspectPlanStoreImports("src/tools/example.ts", source).length, 1, source);
        equal(inspectPlanStoreImports("src/tools/example.test.ts", source).length, 1, source);
    }
    for (const [file, operation] of [
        ["src/shared/workflow/execution-worktree-rescue.ts", "findMissingExecutionSnapshot"],
        ["src/cmd/load-plan/plan-epic-flow.ts", "TargetBranchSnapshotUnavailableError"],
        ["src/shared/workflow/epic-branch.ts", "TargetBranchSnapshotUnavailableError"],
        ["src/shared/workflow/planning-target.ts", "TargetBranchSnapshotUnavailableError"],
        ["src/shared/workflow/planning-worktree-inspection.test.ts", "TargetBranchSnapshotUnavailableError"],
    ]) {
        equal(inspectPlanStoreImports(file, `import { ${operation} } from "${entry}";`).length, 0);
        const unrelated =
            operation === "findMissingExecutionSnapshot"
                ? "TargetBranchSnapshotUnavailableError"
                : "findMissingExecutionSnapshot";
        equal(inspectPlanStoreImports(file, `import { ${unrelated} } from "${entry}";`).length, 1);
        equal(inspectPlanStoreImports(file, `import { readRetainedExecutionPlan } from "${entry}";`).length, 1);
        equal(inspectPlanStoreImports(file, `const driver = await import("${entry}");`).length, 1);
    }
    const specifier = `import.meta.resolve("${entry}");`;
    equal(inspectPlanStoreImports("src/plan-store/managed.ts", specifier).length, 0);
    equal(inspectPlanStoreImports("src/shared/project-runtime-read-denial.test.ts", specifier).length, 0);
    equal(
        inspectPlanStoreImports(
            "src/shared/testing/retained-plan-fixture.ts",
            'import { projectPlanStoreBinding } from "@runwield/plans/project-store-binding";',
        ).length,
        1,
    );
});

test("the Plans package cannot import application code, including type-only imports", () => {
    const file = "packages/plans/lifecycle.ts";
    const source = 'import type { ArchiveRetentionPolicy } from "../../src/shared/settings.ts";';
    equal(inspectPlanStoreImports(file, source).length, 1);
});

test("the public lifecycle and format APIs cannot hide environment I/O", () => {
    const graph = new Map([
        ["packages/plans/index.ts", 'export * from "./lifecycle.ts";'],
        ["packages/plans/lifecycle.ts", 'import { readFileSync } from "node:fs";'],
    ]);
    equal(inspectPlanFormatGraph(graph).length, 1);
});

test("Plan formatting cannot hide persistence behind its pure public facade", () => {
    const graph = new Map([
        ["packages/plans/format.ts", 'export * from "./format/implementation.ts";'],
        ["packages/plans/format/implementation.ts", 'import { loadPlan } from "../../../src/plan-store/index.ts";'],
    ]);
    equal(inspectPlanFormatGraph(graph).length, 1);
    graph.set(
        "packages/plans/format/implementation.ts",
        'import type { PlanFrontMatter } from "../../../src/plan-store/index.ts";',
    );
    equal(inspectPlanFormatGraph(graph).length, 0);
    graph.set("packages/plans/format/implementation.ts", 'import { readFile } from "node:fs/promises";');
    equal(inspectPlanFormatGraph(graph).length, 1);
    graph.set("packages/plans/format/implementation.ts", 'const dependency = "node:fs"; await import(dependency);');
    equal(inspectPlanFormatGraph(graph).length, 1);
});

test("test fixtures cannot become a second production persistence API", () => {
    equal(
        inspectPlanStoreImports(
            "src/tools/example.ts",
            'import { seedPlan } from "../shared/testing/plan-state-fixture.ts";',
        ).length,
        1,
    );
    equal(
        inspectPlanStoreImports(
            "src/plan-store/new-operation.ts",
            'import { seedPlan } from "../shared/testing/plan-state-fixture.ts";',
        ).length,
        1,
    );
    equal(
        inspectPlanStoreImports(
            "src/tools/new.test.ts",
            'import { seedPlan } from "../shared/testing/plan-state-fixture.ts";',
        ).length,
        0,
    );
    equal(
        inspectPlanStoreImports("src/tools/new.test.ts", 'import { updatePlanFrontMatter } from "../plan-store.js";')
            .length,
        1,
    );
    equal(
        inspectPlanStoreImports(
            "src/tools/fixture-proxy.ts",
            'export * from "../shared/testing/plan-state-fixture.ts";',
        ).length,
        1,
    );
});

test("direct filesystem Plan access is rejected through aliases and local path variables", () => {
    for (const source of [
        'import { readFile as read } from "node:fs/promises"; await read(planPath);',
        'import { rename as move } from "node:fs/promises"; await move(temporary, planPath);',
        'import fs from "node:fs/promises"; await fs.copyFile(temporary, planPath);',
        'import fs from "node:fs/promises"; const move = fs.rename; await move(temporary, planPath);',
        'import fs from "node:fs/promises"; await fs["link"](temporary, planPath);',
        'const fs = await import("node:fs/promises"); await fs.rename(temporary, planPath);',
        'const { rename: move } = require("node:fs"); move(temporary, planPath);',
        'import { readFile } from "node:fs/promises"; await readFile(join(cwd, receipt.lifecyclePlan.path));',
        'import { readFile } from "node:fs/promises"; await readFile(plan.path);',
        'import { readFile } from "node:fs/promises"; await readFile(join(dir, "plan.wld.json"));',
        "await Bun.write(planPath, content);",
        "await Deno.rename(temporary, planPath);",

        'import fs from "node:fs/promises"; await fs.writeFile(join(root, "docs/plans/p.md"), content);',
        'import { writeFile as write } from "node:fs/promises"; const target = join(root, PLANS_DIR_NAME, "p.md"); await write(target, content);',
    ])
        equal(inspectPlanFilesystemAccess("src/tools/example.ts", source).length, 1);
    equal(
        inspectPlanFilesystemAccess(
            "src/tools/example.ts",
            'import { readFile } from "node:fs/promises"; await readFile(reportPath);',
        ).length,
        0,
    );
});

test("the public Plan store omits historical checkout query exports", async () => {
    const store = await import("../src/plan-store/index.ts");
    for (const name of [
        "loadPlan",
        "listPlans",
        "listPlanDocuments",
        "findPlanById",
        "findPlanEvidenceById",
        "loadPlanStrict",
        "inspectPlanStrict",
        "loadPlanBodyById",
        "readPlanResourceCatalog",
        "listPlanResources",
        "resolvePlan",
        "findPlansByParent",
        "archivePlan",
        "recordPlanEvent",
        "listArchivedPlans",
        "loadArchivedPlan",
        "restoreArchivedPlan",
        "deleteArchivedPlanUnit",
    ])
        equal(Object.hasOwn(store, name), false, name);
});

test("only qualification code can import historical Plan queries through test support", () => {
    for (const source of [
        'import * as fixture from "../shared/testing/plan-query-fixture.ts";',
        'export * from "../shared/testing/plan-query-fixture.ts";',
        'const fixture = await import("../shared/testing/plan-query-fixture.ts");',
        'const fixture = module.require("../shared/testing/plan-query-fixture.js");',
        'const fixture = module["require"]("../shared/testing/plan-query-fixture.ts");',
        '/** @import { loadPlan } from "../shared/testing/plan-query-fixture.ts" */\nexport const check = 1;',
        'import fixture = require("../shared/testing/plan-query-fixture.ts");',
        'await import("../shared/testing/plan-query-fixture.ts?raw");',
    ]) {
        const violations = inspectPlanStoreImports("src/tools/example.ts", source);
        equal(violations.length, 1, source);
        equal(violations[0].message.includes("test-only Plan support"), true, source);
        equal(inspectPlanStoreImports("src/tools/example.test.ts", source).length, 0, source);
    }
    equal(
        inspectPlanStoreImports("src/tools/example.test.ts", 'import * as queries from "../plan-store/queries.ts";')
            .length,
        1,
    );
});
