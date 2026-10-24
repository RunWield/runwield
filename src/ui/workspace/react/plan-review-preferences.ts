import {
    getUIPreferences,
    PLAN_WIDTH_OPTIONS,
    type UIPreferences,
} from "../../../../third_party/plannotator/packages/ui/utils/uiPreferences.ts";
import { getItem } from "../../../../third_party/plannotator/packages/ui/utils/storage.ts";

/** Keep saved Plannotator choices, but use RunWield's wide default for Plan review. */
export function getPlanReviewPreferences(): UIPreferences {
    const preferences = getUIPreferences();
    // The upstream reader falls back to compact, so check its persisted width before applying our default.
    const savedWidth = getItem("plannotator-plan-width");
    return {
        ...preferences,
        planWidth: PLAN_WIDTH_OPTIONS.some((option) => option.id === savedWidth) ? preferences.planWidth : "wide",
    };
}
