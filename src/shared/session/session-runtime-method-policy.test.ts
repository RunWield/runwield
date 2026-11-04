import { test } from "node:test";
import { SessionRuntime } from "./session-runtime.ts";
import { SESSION_RUNTIME_METHOD_POLICY } from "./session-runtime-method-policy.ts";

type RuntimeMethodPolicyMap = Record<string, string>;

const POLICY_VALUES = new Set([
    "read_only",
    "projection_adapter_local",
    "initializer_adopter",
    "fenced_standalone_mutation",
    "nested_only_mutation",
    "cancellation_cleanup",
]);

function publicMethodNames(prototype: typeof SessionRuntime.prototype): string[] {
    return Object.getOwnPropertyNames(prototype)
        .filter((name) => name !== "constructor")
        .filter((name) => typeof prototype[name as keyof typeof prototype] === "function")
        .sort();
}

function assertCompleteMethodPolicy(methodNames: string[], policy: RuntimeMethodPolicyMap): void {
    const missing = methodNames.filter((name) => !Object.hasOwn(policy, name));
    const extra = Object.keys(policy).filter((name) => !methodNames.includes(name));
    const invalid = Object.entries(policy)
        .filter(([_name, value]) => !POLICY_VALUES.has(value))
        .map(([name, value]) => `${name}:${value}`);
    if (missing.length || extra.length || invalid.length) {
        throw new Error(
            `SessionRuntime method policy mismatch missing=${missing.join(",")} extra=${extra.join(",")} invalid=${invalid.join(
                ",",
            )}`,
        );
    }
}

test("SessionRuntime public methods all have one explicit activation policy", () => {
    assertCompleteMethodPolicy(publicMethodNames(SessionRuntime.prototype), SESSION_RUNTIME_METHOD_POLICY);
});
