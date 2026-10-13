// @ts-nocheck: browser tests install happy-dom globals around React.
import { test } from "node:test";
import { importTestBundle } from "../../testing/import-test-bundle.ts";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { build, stop } from "esbuild";
import { fileURLToPath as fromFileUrl } from "node:url";

test("review completion returns Workspace to its Session and preserves standalone closing", async () => {
    // Bundle the real component as the browser does: upstream imports omit file extensions.
    const bundle = await build({
        entryPoints: [fromFileUrl(new URL("./react/ReviewCompletion.tsx", import.meta.url))],
        bundle: true,
        write: false,
        format: "esm",
        jsx: "automatic",
        alias: {
            "@plannotator/ui": fromFileUrl(new URL("../../../third_party/plannotator/packages/ui", import.meta.url)),
        },
        plugins: [{
            name: "shared-react",
            setup(builder) {
                builder.onResolve(
                    { filter: /^react(?:\/.*)?$/ },
                    (args) => ({ path: import.meta.resolve(args.path), external: true }),
                );
            },
        }],
    });
    stop();
    const { ReviewCompletion } = await importTestBundle(bundle.outputFiles[0].text);
    const browser = new Window({ url: "http://localhost/review" });
    const names = ["window", "document", "location", "CustomEvent", "IS_REACT_ACT_ENVIRONMENT"];
    const previous = new Map(names.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const navigations = [];
    const replacements = [];
    let closeCount = 0;
    let root;
    const container = browser.document.createElement("div");
    browser.document.body.append(container);
    const copy = { title: "Approved", subtitle: "Decision sent", agentLabel: "RunWield" };
    try {
        for (const name of names) {
            const value = name === "window"
                ? browser
                : name === "IS_REACT_ACT_ENVIRONMENT"
                ? true
                : name === "location"
                ? { replace: (href) => replacements.push(href) }
                : browser[name];
            Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        }
        browser.close = () => closeCount++;
        const handleNavigation = (event) => {
            navigations.push(event.detail);
            event.preventDefault();
        };
        browser.document.addEventListener("runwield:workspace-navigate", handleNavigation);
        browser.document.cookie = "plannotator-auto-close=0; path=/";
        root = createRoot(container);
        const payload = { mode: "workspace", reviewContext: { sessionHref: "/projects/p/sessions/s" } };
        await act(() => root.render(<ReviewCompletion {...copy} payload={payload} submitted={null} />));
        assertEquals(navigations.length, 0);
        for (const submitted of ["approved", "approved-run", "approved-later", "approved-decompose", "feedback"]) {
            await act(() =>
                root.render(<ReviewCompletion key={submitted} {...copy} payload={payload} submitted={submitted} />)
            );
        }
        assertEquals(
            navigations,
            Array.from({ length: 5 }, () => ({ href: "/projects/p/sessions/s", history: "replace" })),
        );
        assertEquals(container.textContent, "");
        assertEquals(closeCount, 0);
        assertEquals(replacements, []);

        // Full-window review pages have no Workspace navigation listener.
        browser.document.removeEventListener("runwield:workspace-navigate", handleNavigation);
        await act(() =>
            root.render(
                <ReviewCompletion
                    key="fallback"
                    {...copy}
                    payload={{ mode: "workspace", projectId: "p", runwieldSessionId: "s" }}
                    submitted="approved"
                />,
            )
        );
        assertEquals(replacements, ["/projects/p/sessions/s"]);
        assertEquals(closeCount, 0);

        // Context metadata alone must never turn a standalone review into Workspace.
        const standalone = { ...payload, mode: "standalone" };
        await act(() =>
            root.render(
                <ReviewCompletion key="standalone-auto" {...copy} payload={standalone} submitted="approved-run" />,
            )
        );
        assertEquals(closeCount, 1);
        browser.document.cookie = "plannotator-auto-close=off; path=/";
        await act(() =>
            root.render(<ReviewCompletion key="standalone-off" {...copy} payload={standalone} submitted="approved" />)
        );
        assertEquals(closeCount, 1);
        assertStringIncludes(container.textContent, "You can close this tab and return to");
        assertStringIncludes(container.textContent, "Auto-close this tab after 3 seconds");
        assertEquals(replacements, ["/projects/p/sessions/s"]);
        await act(() => root.unmount());
        root = null;
        // Let the standalone browser-close detection finish inside this browser environment.
        await new Promise((resolve) => setTimeout(resolve, 350));
    } finally {
        if (root) await act(() => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await browser.happyDOM.close();
    }
});
