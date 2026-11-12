import { seedPlanState, seedPlan } from "./plan-state-fixture.ts";

import { loadPlan } from "../../plan-store/index.ts";

import { inspectLocalHomeStore } from "../../plan-store/access.ts";
import { pickControllerState } from "../workflow/controller-state.ts";

/** Arrange authored bytes and historical controller facts in the real store. */
export async function savePlanWithController(...args: Parameters<typeof seedPlan>) {
    const path = await seedPlan(...args);
    const [root, name, , attrs] = args;
    if (inspectLocalHomeStore(root).kind !== "local") return path;
    const saved = await loadPlan(root, name);
    const state = pickControllerState(attrs || {});
    if (saved && Object.keys(state).length) {
        await seedPlanState(root, name, state, saved.attrs, { expectedRevision: saved.revision });
    }
    return path;
}
