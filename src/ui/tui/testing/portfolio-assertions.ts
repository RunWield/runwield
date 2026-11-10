import { assertEquals } from "../../../testing/assertions.ts";
/**
 * @module ui/tui/testing/portfolio-assertions
 * Reusable semantic assertions for Golden TUI portfolio scenarios.
 */

import { ok as assert } from "node:assert/strict";
import { assertEventIncludes, assertScreenIncludes } from "./scenario-runner.ts";

import type { GoldenScenarioResult } from "./scenario-runner.ts";
import type { GoldenAssertionSource, GoldenCoverageAssertion } from "./coverage-matrix.ts";

export interface GoldenCoverageCallback extends GoldenAssertionSource {
    (result: GoldenScenarioResult, capability?: string): void | Promise<void>;
}

export function assertsGoldenCoverage(capability: string, assertion: GoldenCoverageCallback): GoldenCoverageAssertion {
    assert(
        typeof capability === "string" && capability.length > 0,
        "Golden coverage assertion requires one capability.",
    );
    const wrapped = (result: GoldenScenarioResult) => assertion(result);
    Object.defineProperty(wrapped, "goldenCoverage", { value: [capability] });
    const explicitSource = assertion.goldenAssertionSource;
    Object.defineProperty(wrapped, "goldenAssertionSource", {
        value: typeof explicitSource === "string" && explicitSource ? explicitSource : assertion.toString(),
    });
    return wrapped;
}

export function assertRuntimeEvent(capability: string, event: string) {
    const assertion = (result: GoldenScenarioResult) => assertEventIncludes(result, event);
    Object.defineProperty(assertion, "goldenAssertionSource", { value: `event:${event}` });
    return assertsGoldenCoverage(capability, assertion);
}

export function assertVisibleText(capability: string, text: string) {
    const assertion = (result: GoldenScenarioResult) => assertScreenIncludes(result, text);
    Object.defineProperty(assertion, "goldenAssertionSource", { value: `screen:${text}` });
    return assertsGoldenCoverage(capability, assertion);
}

export function assertStateValue(path: string, expected: unknown) {
    return assertsGoldenCoverage("", (result) => {
        const parts = path.split(".").filter(Boolean);
        let value: unknown = result.state;
        for (const part of parts) {
            value = value && typeof value === "object" ? (value as GoldenScenarioResult["state"])[part] : undefined;
        }
        assertEquals(value, expected, `Expected state.${path} to equal ${JSON.stringify(expected)}.`);
    });
}

export function assertStateStringIncludes(path: string, expected: string) {
    return assertsGoldenCoverage("", (result) => {
        const parts = path.split(".").filter(Boolean);
        let value: unknown = result.state;
        for (const part of parts) {
            value = value && typeof value === "object" ? (value as GoldenScenarioResult["state"])[part] : undefined;
        }
        assert(
            typeof value === "string" && value.includes(expected),
            `Expected state.${path} to include ${JSON.stringify(expected)}; got ${JSON.stringify(value)}.`,
        );
    });
}

export function assertCoverageWith(capability: string, assertion: GoldenCoverageCallback) {
    return assertsGoldenCoverage(capability, assertion);
}

export function assertEachCoverageWith(
    capabilities: string[],
    assertion: GoldenCoverageCallback,
): GoldenCoverageAssertion[] {
    assert(
        assertion.length >= 2,
        "assertEachCoverageWith requires a capability-specific assertion callback: (result, capability) => ...",
    );
    return capabilities.map((capability) => assertCoverageWith(capability, (result) => assertion(result, capability)));
}
