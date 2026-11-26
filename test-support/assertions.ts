/** Assertions whose existing call contracts need more than a Node assertion alias. */
import { ok, deepStrictEqual, throws, rejects, fail } from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

export function assertEquals<T, U>(actual: T, expected: U, message?: string): void {
    if (message === undefined) deepStrictEqual(actual, expected);
    else deepStrictEqual(actual, expected, message);
}

type ErrorType<E extends Error> = abstract new (...args: never[]) => E;

export function assertExists<T>(value: T, message?: string): asserts value is NonNullable<T> {
    ok(value !== undefined && value !== null, message ?? "Expected a non-null value");
}

export function assertFalse<T>(value: T, message?: string): void {
    ok(!value, message ?? "Assertion failed");
}

export function assertStringIncludes(actual: string, expected: string, message?: string): void {
    ok(
        actual.includes(expected),
        message ?? `Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`,
    );
}

export function assertLessOrEqual(actual: number, expected: number, message?: string): void {
    ok(actual <= expected, message ?? `Expected ${actual} <= ${expected}`);
}

export function assertArrayIncludes<T, U>(actual: T[], expected: U[], message?: string): void {
    for (const entry of expected)
        ok(
            actual.some((value) => isDeepStrictEqual(value, entry)),
            message ?? "Assertion failed",
        );
}

export function assertInstanceOf<T, C extends abstract new (...args: never[]) => InstanceType<C>>(
    actual: T,
    expected: C,
    message?: string,
): asserts actual is T & InstanceType<C> {
    ok(actual instanceof expected, message ?? "Assertion failed");
}

export function assertThrows<T, E extends Error = Error>(
    fn: () => T,
    expected?: ErrorType<E> | string,
    includes?: string,
    message?: string,
): E {
    let captured: E | undefined;
    throws(
        fn,
        (error) => {
            ok(error instanceof Error, "Expected an Error rejection or throw");
            if (typeof expected === "function") ok(error instanceof expected, message ?? "Assertion failed");
            if (includes !== undefined) assertStringIncludes(error.message, includes, message ?? "Assertion failed");
            captured = error as E;
            return true;
        },
        typeof expected === "string" ? expected : message,
    );
    return captured as E;
}

export async function assertRejects<T, E extends Error = Error>(
    fn: () => T,
    expected?: ErrorType<E> | string,
    includes?: string,
    message?: string,
): Promise<E> {
    let captured: E | undefined;
    let pending: T;
    try {
        pending = fn();
    } catch {
        fail(message ?? "Function throws when expected to reject");
    }
    ok(
        pending !== null && typeof pending === "object" && "then" in pending && typeof pending.then === "function",
        "Expected a Promise",
    );
    await rejects(
        Promise.resolve(pending),
        (error) => {
            ok(error instanceof Error, "Expected an Error rejection or throw");
            if (typeof expected === "function") ok(error instanceof expected, message ?? "Assertion failed");
            if (includes !== undefined) assertStringIncludes(error.message, includes, message ?? "Assertion failed");
            captured = error as E;
            return true;
        },
        typeof expected === "string" ? expected : message,
    );
    return captured as E;
}
