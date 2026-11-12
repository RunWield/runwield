import { enterProjectRuntime } from "../project-runtime-layout.ts";
import { admitProjectIdentity, inspectProjectIdentity } from "../project-identity.ts";
import { withRetainedCheckoutSource } from "../../plan-store/retained-source.ts";

/** Exercise the original checkout owner explicitly. Public import/settlement is covered by cutover acceptance. */
export async function withRetainedPlanFixture<T>(root: string, run: () => Promise<T>): Promise<T> {
    await enterProjectRuntime(root);
    const identity = inspectProjectIdentity(root);
    if (identity.kind !== "existing") throw new Error("Retained fixture requires real Project identity.");
    return await withRetainedCheckoutSource(identity.identity, run);
}

/** Select the retained document owner without adopting pending controller/runtime files. */
export async function withRetainedPlanReadFixture<T>(root: string, run: () => Promise<T>): Promise<T> {
    const admitted = await admitProjectIdentity(root);
    if (admitted.kind !== "existing") throw new Error("Retained read fixture requires real Project identity.");
    return await withRetainedCheckoutSource(admitted.identity, run);
}

import { withoutRetainedCheckoutSource } from "../../plan-store/retained-source.ts";
import { importPlans } from "../../plan-store/index.ts";
/** Arrange a cutover while preserving the test’s retained execution context. */
export async function importCanonicalPlanFixture(root: string, source: string) {
    return await withoutRetainedCheckoutSource(() => importPlans(root, source));
}
