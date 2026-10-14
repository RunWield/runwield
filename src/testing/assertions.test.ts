import { test } from "node:test";
import { throws, rejects, strictEqual } from "node:assert/strict";
import {
    assertEquals,
    assertRejects,
    assertThrows,
    assertExists,
    assertArrayIncludes,
    assertStringIncludes,
} from "./assertions.ts";

test("shared assertions reject unequal values, absent members and missing text", () => {
    throws(() => assertEquals({ key: 1 }, { key: "1" }));
    throws(() => assertArrayIncludes([{ key: 1 }], [{ key: 2 }]));
    throws(() => assertStringIncludes("actual", "missing"));
    throws(() => assertExists(null));
    throws(() => assertExists(undefined));
    assertExists(0);
    assertExists(false);
    assertArrayIncludes([{ key: 1 }, { key: 2 }], [{ key: 2 }]);
});

test("error assertions check class and message and return the original error", async () => {
    const error = new TypeError("expected detail");
    strictEqual(
        assertThrows(
            () => {
                throw error;
            },
            TypeError,
            "detail",
        ),
        error,
    );
    strictEqual(await assertRejects(() => Promise.reject(error), TypeError, "detail"), error);
    throws(() =>
        assertThrows(() => {
            throw error;
        }, RangeError),
    );
    throws(() =>
        assertThrows(
            () => {
                throw error;
            },
            TypeError,
            "missing",
        ),
    );
    throws(() => assertThrows(() => {}));
    await rejects(() => assertRejects(() => Promise.reject(error), RangeError));
    await rejects(() => assertRejects(() => Promise.reject(error), TypeError, "missing"));
    await rejects(() => assertRejects(() => Promise.resolve()));
    await rejects(() =>
        assertRejects(() => {
            throw error;
        }),
    );
});
