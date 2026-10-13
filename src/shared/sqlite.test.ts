import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEquals, assertThrows } from "../testing/assertions.ts";
import { DatabaseSync } from "./sqlite.ts";

test("SQLite closes prepared statements before a database file is recreated", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-sqlite-close-"));
    const path = join(root, "store.sqlite3");
    try {
        const first = new DatabaseSync(path);
        first.exec("PRAGMA journal_mode = WAL; CREATE TABLE items(value TEXT); INSERT INTO items VALUES ('old');");
        const statement = first.prepare("SELECT value FROM items");
        assertEquals(statement.get()?.value, "old");
        first.close();
        assertThrows(() => statement.get());
        await rm(path);
        const second = new DatabaseSync(path);
        try {
            second.exec("PRAGMA journal_mode = WAL; CREATE TABLE items(value TEXT); INSERT INTO items VALUES ('new');");
            assertEquals(second.prepare("SELECT value FROM items").get()?.value, "new");
        } finally {
            second.close();
        }
    } finally {
        await rm(root, { recursive: true });
    }
});

test("SQLite preserves absent rows, positional bindings, changes, and read-only connections", async () => {
    const root = await mkdtemp(join(tmpdir(), "runwield-sqlite-contract-"));
    const path = join(root, "store.sqlite3");
    try {
        const writer = new DatabaseSync(path);
        try {
            writer.exec("CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)");
            assertEquals(writer.prepare("SELECT value FROM items WHERE id = ?").get(1), undefined);
            assertEquals(Number(writer.prepare("INSERT INTO items(value) VALUES (?)").run("saved").changes), 1);
            assertEquals(writer.prepare("SELECT value FROM items WHERE id = ?").get(1)?.value, "saved");
        } finally {
            writer.close();
        }
        const reader = new DatabaseSync(path, { readOnly: true });
        try {
            assertEquals(reader.prepare("SELECT value FROM items").all().map((row) => row.value), ["saved"]);
            assertThrows(() => reader.exec("DELETE FROM items"));
        } finally {
            reader.close();
        }
    } finally {
        await rm(root, { recursive: true });
    }
});

test("SQLite reports direct changes without counting foreign-key cascades", () => {
    const db = new DatabaseSync(":memory:");
    try {
        db.exec(
            "PRAGMA foreign_keys = ON; CREATE TABLE parents(id INTEGER PRIMARY KEY); CREATE TABLE children(parent INTEGER REFERENCES parents(id) ON DELETE CASCADE); INSERT INTO parents VALUES (1); INSERT INTO children VALUES (1), (1);",
        );
        assertEquals(Number(db.prepare("DELETE FROM parents WHERE id = ?").run(1).changes), 1);
        assertEquals(db.prepare("SELECT parent FROM children").all(), []);
    } finally {
        db.close();
    }
});
