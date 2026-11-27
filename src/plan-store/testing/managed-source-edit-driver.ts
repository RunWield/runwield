import { ok } from "node:assert/strict";
import { activateRemoteProjectOwner } from "../../shared/remote/managed-project-owner.ts";
import type { RemoteInteractiveConfig } from "../../shared/remote/entry.ts";

const config: Pick<RemoteInteractiveConfig, "cwd" | "resources" | "connection"> = JSON.parse(process.argv[2]);
const close = await activateRemoteProjectOwner(config);
try {
    const { loadPlan } = await import("../../shared/testing/plan-query-fixture.ts");
    const { createMultiFileEditTool } = await import("../../tools/multi_file_edit.ts");
    const plan = await loadPlan(config.cwd, "mixed");
    ok(plan);
    const tool = createMultiFileEditTool(config.cwd);
    const result = await tool.execute(
        "edit-mixed",
        {
            edits: [
                { path: "source.txt", oldText: "Original source", newText: "Updated source" },
                { path: "clear.txt", oldText: "Remove me", newText: "" },
                { path: "conflict.txt", oldText: "Before", newText: "After" },
                { path: plan.path, oldText: "Original Plan", newText: "Updated Plan" },
            ],
        },
        new AbortController().signal,
        () => {},
        {} as Parameters<typeof tool.execute>[4],
    );
    console.log(JSON.stringify(result));
} finally {
    close();
}
