import { assertEquals } from "../testing/assertions.ts";
import fsPromises from "node:fs/promises";
import { test } from "node:test";
import { mkdir as fsMkdir, mkdtemp as fsMkdtemp, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isEmptyProjectDirectory } from "./project-state.ts";

type TempProjectCheck = (dir: string) => Promise<void>;

async function withTempProject(prefix: string, fn: TempProjectCheck): Promise<void> {
    const dir = await fsMkdtemp(join(tmpdir(), prefix));
    try {
        await fn(dir);
    } finally {
        await fsRm(dir, { recursive: true });
    }
}

test("truly empty directory is empty project directory", async () => {
    await withTempProject("runwield-empty-project-", async (dir) => {
        assertEquals(await isEmptyProjectDirectory(dir), true);
    });
});

test("only dot-prefixed files and folders are empty project directory", async () => {
    await withTempProject("runwield-dot-project-", async (dir) => {
        await fsMkdir(join(dir, ".git"));
        await fsMkdir(join(dir, ".wld"));
        await fsMkdir(join(dir, ".vscode"));
        await fsWriteFile(join(dir, ".DS_Store"), "metadata");
        await fsWriteFile(join(dir, ".git", "config"), "git config");

        assertEquals(await isEmptyProjectDirectory(dir), true);
    });
});

test("empty visible folder is empty project directory", async () => {
    await withTempProject("runwield-visible-dir-project-", async (dir) => {
        await fsMkdir(join(dir, "src"));

        assertEquals(await isEmptyProjectDirectory(dir), true);
    });
});

test("zero-byte visible file is empty project directory", async () => {
    await withTempProject("runwield-zero-file-project-", async (dir) => {
        await fsWriteFile(join(dir, "README.md"), "");

        assertEquals(await isEmptyProjectDirectory(dir), true);
    });
});

test("non-empty visible README is not empty project directory", async () => {
    await withTempProject("runwield-readme-project-", async (dir) => {
        await fsWriteFile(join(dir, "README.md"), "# Project\n");

        assertEquals(await isEmptyProjectDirectory(dir), false);
    });
});

test("non-empty nested visible file is not empty project directory", async () => {
    await withTempProject("runwield-nested-project-", async (dir) => {
        await fsMkdir(join(dir, "src"));
        await fsWriteFile(join(dir, "src", "main.js"), "console.log('hi');\n");

        assertEquals(await isEmptyProjectDirectory(dir), false);
    });
});

test("non-empty file under dot-prefixed segment is empty project directory", async () => {
    await withTempProject("runwield-dot-nested-project-", async (dir) => {
        await fsMkdir(join(dir, ".cache"));
        await fsWriteFile(join(dir, ".cache", "generated.txt"), "generated\n");

        assertEquals(await isEmptyProjectDirectory(dir), true);
    });
});

test("root read failure degrades to not empty project directory", async () => {
    await withTempProject("runwield-root-read-failure-project-", async (dir) => {
        const originalReadDir = fsPromises.opendir;
        try {
            Object.defineProperty(fsPromises, "opendir", {
                configurable: true,
                value: (path: string | URL) => {
                    if (path === dir) throw new Error("simulated root read failure");
                    return originalReadDir(path);
                },
            });

            assertEquals(await isEmptyProjectDirectory(dir), false);
        } finally {
            fsPromises.opendir = originalReadDir;
        }
    });
});

test("nested visible directory read failure degrades to not empty project directory", async () => {
    await withTempProject("runwield-nested-read-failure-project-", async (dir) => {
        const srcDir = join(dir, "src");
        await fsMkdir(srcDir);

        const originalReadDir = fsPromises.opendir;
        try {
            Object.defineProperty(fsPromises, "opendir", {
                configurable: true,
                value: (path: string | URL) => {
                    if (path === srcDir) throw new Error("simulated nested read failure");
                    return originalReadDir(path);
                },
            });

            assertEquals(await isEmptyProjectDirectory(dir), false);
        } finally {
            fsPromises.opendir = originalReadDir;
        }
    });
});

test("visible entry stat failure degrades to not empty project directory", async () => {
    await withTempProject("runwield-stat-failure-project-", async (dir) => {
        const readmePath = join(dir, "README.md");
        await fsWriteFile(readmePath, "");

        const originalLstat = fsPromises.lstat;
        try {
            Object.defineProperty(fsPromises, "lstat", {
                configurable: true,
                value: (path: string | URL) => {
                    if (path === readmePath) throw new Error("simulated stat failure");
                    return originalLstat(path);
                },
            });

            assertEquals(await isEmptyProjectDirectory(dir), false);
        } finally {
            fsPromises.lstat = originalLstat;
        }
    });
});
