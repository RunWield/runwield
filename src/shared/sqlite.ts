/** Runtime SQLite boundary with deterministic native connection closure. */
import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { versions } from "node:process";
import { createRequire } from "node:module";

export type SqliteRow = Record<string, SQLOutputValue>;
interface SqliteRunResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
}
interface NativeStatement {
    get(...values: SQLInputValue[]): SqliteRow | null | undefined;
    all(...values: SQLInputValue[]): SqliteRow[];
    run(...values: SQLInputValue[]): SqliteRunResult;
}
interface NativeDatabase {
    exec(sql: string): void;
    prepare(sql: string): NativeStatement;
    close(force?: boolean): void;
}
interface BunDatabaseOptions {
    readonly: boolean;
    create: boolean;
    strict: boolean;
}
interface BunSqliteModule {
    Database: new (path: string, options: BunDatabaseOptions) => NativeDatabase;
}
interface DatabaseOptions {
    readOnly?: boolean;
}
// Keep this synchronous: top-level await makes Deno's bundled command graph stall on its import cycles.
const bunSqlite: BunSqliteModule | null = versions.bun ? createRequire(import.meta.url)("bun:sqlite") : null;

/** The shared synchronous subset used by RunWield's durable stores. */
export class DatabaseSync {
    readonly #database: NativeDatabase;
    readonly #changes: NativeStatement | null;
    constructor(path: string, options: DatabaseOptions = {}) {
        this.#database = bunSqlite
            ? new bunSqlite.Database(path, {
                readonly: options.readOnly === true,
                create: !options.readOnly,
                strict: true,
            })
            : new NodeDatabaseSync(path, options);
        try {
            this.#changes = bunSqlite ? this.#database.prepare("SELECT changes() AS changes") : null;
        } catch (error) {
            // A corrupt database can fail during statement preparation after opening
            // its file. Release that handle before construction reports the failure.
            this.close();
            throw error;
        }
    }
    exec(sql: string): void {
        this.#database.exec(sql);
    }
    prepare(sql: string) {
        const statement = this.#database.prepare(sql);
        return {
            get: (...values: SQLInputValue[]): SqliteRow | undefined => statement.get(...values) ?? undefined,
            all: (...values: SQLInputValue[]): SqliteRow[] => statement.all(...values),
            run: (...values: SQLInputValue[]): SqliteRunResult => {
                const result = statement.run(...values);
                // Bun reports total changes including trigger effects; Node reports only this statement.
                const changes = bunSqlite ? Number(this.#changes?.get()?.changes ?? 0) : result.changes;
                return { ...result, changes };
            },
        };
    }
    close(): void {
        // Bun's node:sqlite compatibility close leaves native statements alive.
        // Native close(true) finalizes every statement and releases the connection immediately.
        if (bunSqlite) this.#database.close(true);
        else this.#database.close();
    }
}
