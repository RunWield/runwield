import { test } from "node:test";
import { equal } from "node:assert/strict";
import {
    inspectPlanStoreImports,
    inspectPlanFormatGraph,
    inspectPlanFilesystemAccess,
} from "./check-plan-store-boundary.ts";

test("Plan boundary catches static imports, reexports, type queries and constructed dynamic imports", () => {
    const cases = [
        'import { readPlanPackage as hidden } from "../plan-store/packages.ts";',
        'export * from "../plan-store/workflows.ts";',
        'type Hidden = import("../plan-store/packages.ts").LoadedPlanPackage;',
        'await import("../plan-store/packages.ts");',
        'require("../plan-store.js");',
        'const base = "../plan-store/"; await import(`${base}packages.ts`);',
        'const target = "../plan-store/" + "packages.ts"; await import(target);',
        'export { readPlanPackage as publicRead } from "../plan-store/packages.ts";',
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

test("only the Plan store binds the retained-input filesystem driver", () => {
    const source = 'import { readRetainedPlanInput } from "@runwield/plans/file-snapshots";';
    equal(inspectPlanStoreImports("src/plan-store/packages.ts", source).length, 0);
    equal(inspectPlanStoreImports("src/tools/example.ts", source).length, 1);
    equal(inspectPlanStoreImports("packages/plans/index.ts", source).length, 1);
});

test("the Plans package cannot import application code, including type-only imports", () => {
    const file = "packages/plans/lifecycle.ts";
    const source = 'import type { Project } from "../../src/shared/project-runtime-layout.ts";';
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
