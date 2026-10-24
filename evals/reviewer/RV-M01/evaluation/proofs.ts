import assert from "node:assert/strict";
import type { ProjectCatalog } from "../src/model.ts";
import { listProjects } from "../src/project-list.ts";

const proof = process.argv[2];
if (proof === "explicit-false") {
    // One terminal page: pagination cannot affect this proof.
    const catalog: ProjectCatalog = { page: async () => ({ items: [{ id: "old", archived: true }] }) };
    assert.deepEqual(
        await listProjects(catalog, { filterEnabled: false }),
        [{ id: "old", archived: true }],
        "RV-M01-FALSE-DEFAULT",
    );
} else if (proof === "empty-cursor-page") {
    // Explicit true and only active projects: boolean normalization cannot affect this proof.
    const catalog: ProjectCatalog = {
        page: async (cursor) => {
            if (cursor === undefined) return { items: [{ id: "one", archived: false }], nextCursor: "middle" };
            if (cursor === "middle") return { items: [], nextCursor: "last" };
            if (cursor === "last") return { items: [{ id: "three", archived: false }] };
            throw new Error("Unexpected cursor");
        },
    };
    assert.deepEqual(
        await listProjects(catalog, { filterEnabled: true }),
        [
            { id: "one", archived: false },
            { id: "three", archived: false },
        ],
        "RV-M01-EMPTY-PAGE-STOP",
    );
} else {
    throw new Error("Select explicit-false or empty-cursor-page");
}
console.log("PASS " + proof);
