import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueCapability } from "../src/capabilities.ts";
import { handleBoardLink } from "../src/service.ts";
import type { Role } from "../src/model.ts";

const key = "local-test-capability-key";
function linkFor(role: Role, boardId = "gallery"): string {
    const url = new URL("https://boards.example.test/shared");
    url.searchParams.set("board", boardId);
    url.searchParams.set("cap", issueCapability(key, { boardId, role }));
    url.searchParams.set("role", role);
    return url.href;
}
async function withBoards(check: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "board-links-"));
    try {
        await writeFile(
            join(root, "boards.json"),
            JSON.stringify([
                { id: "gallery", title: "Exhibition" },
                { id: "private", title: "Private notes" },
            ]),
        );
        await check(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}
await withBoards(async (root) => {
    const result = await handleBoardLink(root, key, linkFor("reviewer"));
    assert.equal(result.status, 200);
    assert.equal(result.board?.title, "Exhibition");
});
console.log("PASS reviewer capabilities can read a board");
await withBoards(async (root) => {
    const url = new URL(linkFor("maintainer"));
    url.searchParams.set("board", "private");
    assert.equal((await handleBoardLink(root, key, url.href)).status, 403);
});
console.log("PASS capabilities are scoped to one board");
await withBoards(async (root) => {
    const url = new URL(linkFor("reviewer"));
    url.searchParams.set("cap", url.searchParams.get("cap")!.replace(".reviewer.", ".maintainer."));
    await assert.rejects(handleBoardLink(root, key, url.href), /Invalid capability/);
});
console.log("PASS editing signed claims does not produce a valid capability");
