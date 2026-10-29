import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueCapability } from "../src/capabilities.ts";
import { handleBoardLink } from "../src/service.ts";

if (process.argv[2] !== "role-promotion") throw new Error("Select role-promotion");
const root = await mkdtemp(join(tmpdir(), "capability-proof-"));
const key = "proof-server-signing-key";
try {
    await writeFile(join(root, "boards.json"), JSON.stringify([{ id: "gallery", title: "Owner title" }]));
    const url = new URL("https://boards.example.test/shared");
    url.searchParams.set("board", "gallery");
    url.searchParams.set("cap", issueCapability(key, { boardId: "gallery", role: "reviewer" }));
    url.searchParams.set("role", "maintainer");
    const result = await handleBoardLink(root, key, url.href, "Unauthorized title");
    const read = await handleBoardLink(root, key, url.href);
    assert.equal(read.board?.title, "Owner title", "RV-D06-ROLE-PROMOTION");
    assert.equal(result.status, 403, "RV-D06-ROLE-PROMOTION");
    assert.equal(result.displayRole, "maintainer");
    // A signed maintainer remains authorized even when its display hint says reviewer or is omitted.
    url.searchParams.set("cap", issueCapability(key, { boardId: "gallery", role: "maintainer" }));
    url.searchParams.set("role", "reviewer");
    assert.equal(
        (await handleBoardLink(root, key, url.href, "Verified title")).status,
        200,
        "Verified maintainer keeps authority with a reviewer display hint",
    );
    url.searchParams.delete("role");
    assert.equal(
        (await handleBoardLink(root, key, url.href, "Final title")).status,
        200,
        "Verified maintainer keeps authority without a display hint",
    );
    assert.equal((await handleBoardLink(root, key, url.href)).board?.title, "Final title");
    console.log("PASS role-promotion");
} finally {
    await rm(root, { recursive: true, force: true });
}
