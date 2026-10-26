import { test } from "node:test";
import { strictEqual } from "node:assert";
import { selectPlanFlowRestoreAgent } from "./plan-session-surface.ts";

test("Plan continuation keeps the Plan owner instead of restoring Epic-scoped Slicer", () => {
    strictEqual(selectPlanFlowRestoreAgent("slicer", "planner"), "planner");
    strictEqual(selectPlanFlowRestoreAgent("slicer", "architect"), "architect");
});

test("Plan continuation yields Router to the Plan owner but preserves other specialists", () => {
    strictEqual(selectPlanFlowRestoreAgent("router", "planner"), "planner");
    strictEqual(selectPlanFlowRestoreAgent("guide", "planner"), "guide");
});
