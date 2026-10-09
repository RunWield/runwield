import { assertEquals } from "../../../testing/assertions.ts";
/**
 * @module ui/tui/testing/portfolio-assertions
 * Reusable semantic assertions for Golden TUI portfolio scenarios.
 */

import { ok as assert } from "node:assert/strict";
import { assertEventIncludes, assertScreenIncludes } from "./scenario-runner.js";

/** @typedef {import('./scenario-runner.js').GoldenScenarioResult} GoldenScenarioResult */

/**
 * @param {string} capability
 * @param {(result: GoldenScenarioResult, capability?: string) => void | Promise<void>} assertion
 * @returns {(result: GoldenScenarioResult) => void | Promise<void>}
 */
export function assertsGoldenCoverage(capability, assertion) {
    assert(
        typeof capability === "string" && capability.length > 0,
        "Golden coverage assertion requires one capability.",
    );
    const wrapped = (/** @type {GoldenScenarioResult} */ result) => assertion(result);
    Object.defineProperty(wrapped, "goldenCoverage", { value: [capability] });
    const explicitSource = /** @type {{ goldenAssertionSource?: unknown }} */ (assertion).goldenAssertionSource;
    Object.defineProperty(wrapped, "goldenAssertionSource", {
        value: typeof explicitSource === "string" && explicitSource ? explicitSource : assertion.toString(),
    });
    return wrapped;
}

/**
 * @param {string} capability
 * @param {string} event
 */
export function assertRuntimeEvent(capability, event) {
    const assertion = (/** @type {GoldenScenarioResult} */ result) => assertEventIncludes(result, event);
    Object.defineProperty(assertion, "goldenAssertionSource", { value: `event:${event}` });
    return assertsGoldenCoverage(capability, assertion);
}

/**
 * @param {string} capability
 * @param {string} text
 */
export function assertVisibleText(capability, text) {
    const assertion = (/** @type {GoldenScenarioResult} */ result) => assertScreenIncludes(result, text);
    Object.defineProperty(assertion, "goldenAssertionSource", { value: `screen:${text}` });
    return assertsGoldenCoverage(capability, assertion);
}

/**
 * @param {string} path
 * @param {unknown} expected
 */
export function assertStateValue(path, expected) {
    return assertsGoldenCoverage("", (result) => {
        const parts = path.split(".").filter(Boolean);
        /** @type {unknown} */
        let value = result.state;
        for (const part of parts) {
            value = value && typeof value === "object"
                ? /** @type {Record<string, unknown>} */ (value)[part]
                : undefined;
        }
        assertEquals(value, expected, `Expected state.${path} to equal ${JSON.stringify(expected)}.`);
    });
}

/**
 * @param {string} path
 * @param {string} expected
 */
export function assertStateStringIncludes(path, expected) {
    return assertsGoldenCoverage("", (result) => {
        const parts = path.split(".").filter(Boolean);
        /** @type {unknown} */
        let value = result.state;
        for (const part of parts) {
            value = value && typeof value === "object"
                ? /** @type {Record<string, unknown>} */ (value)[part]
                : undefined;
        }
        assert(
            typeof value === "string" && value.includes(expected),
            `Expected state.${path} to include ${JSON.stringify(expected)}; got ${JSON.stringify(value)}.`,
        );
    });
}

/**
 * @param {string} capability
 * @param {(result: GoldenScenarioResult, capability?: string) => void | Promise<void>} assertion
 */
export function assertCoverageWith(capability, assertion) {
    return assertsGoldenCoverage(capability, assertion);
}

/**
 * @param {string[]} capabilities
 * @param {(result: GoldenScenarioResult, capability?: string) => void | Promise<void>} assertion
 * @returns {Array<(result: GoldenScenarioResult) => void | Promise<void>>}
 */
export function assertEachCoverageWith(capabilities, assertion) {
    assert(
        assertion.length >= 2,
        "assertEachCoverageWith requires a capability-specific assertion callback: (result, capability) => ...",
    );
    return capabilities.map((capability) => assertCoverageWith(capability, (result) => assertion(result, capability)));
}
