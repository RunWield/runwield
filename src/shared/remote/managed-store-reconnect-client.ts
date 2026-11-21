/** A reconnect starts a fresh remote process and reuses only the admitted personal owner. */
import { stdinStream } from "../../testing/stdin-stream.ts";
import { processLines } from "./remote-runtime-lines.ts";
import { activateRemoteProjectOwner, type RemoteInteractiveConfig } from "./entry.ts";
const lines = processLines(stdinStream());
const input: Pick<RemoteInteractiveConfig, "cwd" | "resources" | "connection"> & {
    planId: string;
    expectedPath: string;
} = JSON.parse((await lines.read()).value || "{}");
await lines.cancel();
const clear = await activateRemoteProjectOwner(input);
try {
    const { loadPlan, withLocalPlanWorkflow, readPlanResource } = await import("../../plan-store/index.ts");
    const plan = await loadPlan(input.cwd, input.planId);
    if (!plan || plan.path !== input.expectedPath || !plan.path.startsWith(input.resources.globalRoot))
        throw new Error("Reconnect changed canonical ownership.");
    await withLocalPlanWorkflow(input.cwd, input.planId, async () => {
        const document = await readPlanResource(input.cwd, { planId: input.planId, planName: "import-source" });
        if (!document.body.includes("Preserve source bytes."))
            throw new Error("Reconnect lost canonical imported bytes.");
    });
} finally {
    clear();
}
