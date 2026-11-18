import { test } from "node:test";
import { doesNotThrow, throws } from "node:assert";
import { versions } from "node:process";
import { requireSupportedBun } from "./check-bun-runtime.ts";

for (const version of ["1.4.0", "1.4.3", "1.4.4", "1.5.0", "1.99.0"]) {
    test(`local commands accept Bun ${version}`, () => {
        const descriptor = Object.getOwnPropertyDescriptor(versions, "bun")!;
        try {
            Object.defineProperty(versions, "bun", { ...descriptor, value: version });
            doesNotThrow(() => requireSupportedBun());
        } finally {
            Object.defineProperty(versions, "bun", descriptor);
        }
    });
}

for (const version of ["1.3.12", "2.0.0", "1.4.0-canary.1", undefined]) {
    test(`local commands reject ${version ? `Bun ${version}` : "another runtime"}`, () => {
        const descriptor = Object.getOwnPropertyDescriptor(versions, "bun")!;
        try {
            Object.defineProperty(versions, "bun", { ...descriptor, value: version });
            throws(() => requireSupportedBun(), {
                message: `RunWield requires Bun ^1.4.0; found ${version || "another runtime"}.`,
            });
        } finally {
            Object.defineProperty(versions, "bun", descriptor);
        }
    });
}
