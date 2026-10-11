import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { act } from "react";
import { useReviewAnnotations } from "./use-review-annotations.ts";

function Panel({ count }: { count: number }) {
    const [open, setOpen] = useReviewAnnotations(count);
    return <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>Annotations</button>;
}

Deno.test("review annotations open once for the first note and respect subsequent manual choices", async () => {
    const browser = new Window({ url: "http://workspace.local" });
    const globals = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"];
    const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const container = browser.document.createElement("div");
    browser.document.body.append(container);
    try {
        Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
        Object.defineProperty(globalThis, "document", { configurable: true, value: browser.document });
        Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
        const { createRoot } = await import("react-dom/client");
        const root = createRoot(container);
        const button = () => container.querySelector("button")!;
        const expanded = () => button().getAttribute("aria-expanded");
        try {
            await act(() => root.render(<Panel count={0} />));
            assertEquals(expanded(), "false");
            await act(() => button().click());
            assertEquals(expanded(), "true");
            await act(() => button().click());
            await act(() => root.render(<Panel count={1} />));
            assertEquals(expanded(), "true");
            await act(() => button().click());
            await act(() => root.render(<Panel count={2} />));
            assertEquals(expanded(), "false");
            await act(() => root.render(<Panel count={0} />));
            await act(() => root.render(<Panel count={1} />));
            assertEquals(expanded(), "false");
            await act(() => button().click());
            assertEquals(expanded(), "true");
        } finally {
            await act(() => root.unmount());
        }
    } finally {
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await browser.happyDOM.close();
    }
});
