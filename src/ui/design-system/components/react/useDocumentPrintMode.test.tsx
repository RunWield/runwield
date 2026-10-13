// @ts-nocheck: happy-dom browser globals are installed for this test.
import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals, assertStringIncludes } from "../../../../testing/assertions.ts";
import { Window } from "happy-dom";

test("printing splits oversized callouts and keeps short callouts together", async () => {
    const browser = new Window();
    const names = [
        "window",
        "document",
        "HTMLElement",
        "Event",
        "addEventListener",
        "removeEventListener",
        "dispatchEvent",
    ];
    const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
    for (const name of names) {
        Object.defineProperty(globalThis, name, {
            configurable: true,
            writable: true,
            value: name === "window"
                ? browser
                : typeof browser[name] === "function"
                ? browser[name].bind(browser)
                : browser[name],
        });
    }
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const { createElement, act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useDocumentPrintMode } = await import("./useDocumentPrintMode.ts");
    const rootElement = browser.document.createElement("div");
    rootElement.className = "rw-plan-review";
    rootElement.innerHTML =
        '<article data-print-region="article"><div class="alert" id="short"></div><div class="alert" id="long"></div></article>';
    browser.document.body.append(rootElement);
    const short = rootElement.querySelector("#short");
    const long = rootElement.querySelector("#long");
    short.getBoundingClientRect = () => ({ height: 120 });
    long.getBoundingClientRect = () => ({ height: 980 });
    const mount = browser.document.createElement("div");
    browser.document.body.append(mount);
    function TestComponent() {
        useDocumentPrintMode();
        return null;
    }
    const root = createRoot(mount);
    try {
        await act(() => root.render(createElement(TestComponent)));
        browser.dispatchEvent(new browser.Event("runwield:prepare-print"));
        assertEquals(short.hasAttribute("data-print-long-callout"), false);
        assertEquals(long.hasAttribute("data-print-long-callout"), true);
        const css = await fsReadFile("src/ui/design-system/print.css", "utf8");
        assertStringIncludes(
            css,
            ".rw-plan-review :is(.alert, .directive, blockquote) {\n        break-inside: avoid;",
        );
        assertStringIncludes(
            css,
            ".rw-plan-review :is(.alert, .directive, blockquote)[data-print-long-callout] {\n        break-inside: auto;",
        );
        browser.dispatchEvent(new browser.Event("afterprint"));
        assertEquals(long.hasAttribute("data-print-long-callout"), false);
    } finally {
        await act(() => root.unmount());
        await browser.happyDOM.close();
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        if (previousAct === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
        else globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
    }
});
