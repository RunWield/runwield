import { assertEquals } from "../../../testing/assertions.ts";
import { test } from "node:test";
import { Window } from "happy-dom";
import { updateReviewInteractionUrl } from "./review-navigation.ts";

test("revised reviews reload the new interaction while retaining operation and return context", async () => {
    const browser = new Window({
        url: "http://localhost/projects/project/plans/plan?session=session&operation=operation&interaction=old&return=%2Fsearch#section",
    });
    const descriptors = new Map(
        ["location", "history"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    try {
        Object.defineProperty(globalThis, "location", { configurable: true, value: browser.location });
        Object.defineProperty(globalThis, "history", { configurable: true, value: browser.history });
        browser.history.replaceState({ scroll: 42 }, "", browser.location.href);
        updateReviewInteractionUrl("revised");
        const reloaded = new URL(browser.location.href);
        assertEquals(reloaded.searchParams.get("interaction"), "revised");
        assertEquals(reloaded.searchParams.get("operation"), "operation");
        assertEquals(reloaded.searchParams.get("session"), "session");
        assertEquals(reloaded.searchParams.get("return"), "/search");
        assertEquals(reloaded.hash, "#section");
        assertEquals(browser.history.state, { scroll: 42 });
    } finally {
        for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await browser.happyDOM.close();
    }
});
