import { enterProjectRuntime } from "../project-runtime-layout.ts";
import { inspectProjectIdentity } from "../project-identity.ts";
import { withRetainedCheckoutSource } from "../legacy-plan-source.ts";

/** Exercise the original checkout owner explicitly. Public import/settlement is covered by cutover acceptance. */
export async function withRetainedPlanFixture<T>(root: string, run: () => Promise<T>): Promise<T> {
    await enterProjectRuntime(root);
    const identity = inspectProjectIdentity(root);
    if (identity.kind !== "existing") throw new Error("Retained fixture requires real Project identity.");
    return await withRetainedCheckoutSource(identity.identity, run);
}
