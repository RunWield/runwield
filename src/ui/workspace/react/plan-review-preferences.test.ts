import { test } from "node:test";
import { Window } from "happy-dom";
import { assertEquals } from "../../../testing/assertions.ts";
import { getPlanReviewPreferences } from "./plan-review-preferences.ts";
import { saveUIPreferences } from "../../../../third_party/plannotator/packages/ui/utils/uiPreferences.ts";

for (const savedWidth of [null, "invalid", "compact", "default", "wide"]) {
    test(`Plan Review uses ${savedWidth === null || savedWidth === "invalid" ? "wide" : savedWidth} with saved width ${savedWidth}`, async () => {
        const browser = new Window({ url: "http://localhost/review" });
        const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
        try {
            Object.defineProperty(globalThis, "document", {
                configurable: true,
                value: browser.document,
            });
            if (savedWidth !== null) browser.document.cookie = `plannotator-plan-width=${savedWidth}; path=/`;
            browser.document.cookie = "plannotator-toc-enabled=false; path=/";
            browser.document.cookie = "plannotator-sticky-actions-enabled=false; path=/";
            const preferences = getPlanReviewPreferences();
            assertEquals(preferences, {
                planWidth: savedWidth === null || savedWidth === "invalid" ? "wide" : savedWidth,
                tocEnabled: false,
                stickyActionsEnabled: false,
            });
            saveUIPreferences({ ...preferences, planWidth: "compact" });
            assertEquals(getPlanReviewPreferences().planWidth, "compact");
        } finally {
            if (previous) Object.defineProperty(globalThis, "document", previous);
            else Reflect.deleteProperty(globalThis, "document");
            await browser.happyDOM.close();
        }
    });
}
