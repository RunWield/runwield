import { test } from "node:test";
import { notStrictEqual as assertNotStrictEquals, strictEqual as assertStrictEquals } from "node:assert/strict";
import { openFileSessionStore } from "./file-session-store.ts";
import { FileSessionStoreOwner } from "./file-session-store-owner.ts";

test("FileSessionStoreOwner closes and forgets stores it opens", () => {
    const owner = new FileSessionStoreOwner(null);
    const first = owner.ensure();
    owner.closeOwned();
    const second = owner.ensure();
    try {
        assertNotStrictEquals(second, first);
    } finally {
        owner.closeOwned();
    }
});

test("FileSessionStoreOwner leaves caller-owned stores open", () => {
    const store = openFileSessionStore();
    const owner = new FileSessionStoreOwner(store);
    try {
        owner.closeOwned();
        assertStrictEquals(owner.current(), store);
    } finally {
        store.close();
    }
});
