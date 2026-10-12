// @ts-nocheck: browser tests install happy-dom globals around React.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { build, stop } from "esbuild";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";

// Run the real island, including its document viewer, with the same React as the test root.
const bundle = await build({
    entryPoints: [fromFileUrl(new URL("./react/ArtifactReadSurface.tsx", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    banner: {
        js: `import { createRequire } from "node:module"; const require = createRequire(${
            JSON.stringify(import.meta.url)
        });`,
    },
    jsx: "automatic",
    loader: { ".css": "empty", ".png": "dataurl" },
    alias: {
        "@plannotator/ui": fromFileUrl(new URL("../../../third_party/plannotator/packages/ui", import.meta.url)),
        "@plannotator/core": fromFileUrl(new URL("../../../third_party/plannotator/packages/core", import.meta.url)),
    },
    plugins: [{
        name: "shared-react",
        setup(builder) {
            builder.onResolve(
                { filter: /^react(?:-dom)?(?:\/.*)?$/ },
                (args) => ({
                    path: args.kind === "require-call"
                        ? fromFileUrl(import.meta.resolve(args.path))
                        : import.meta.resolve(args.path),
                    external: true,
                }),
            );
        },
    }],
});
stop();

/**
 * @typedef {Object} ReaderPayload
 * @property {string} mode
 * @property {string} token
 * @property {string} artifactKind
 * @property {string} markdown
 * @property {string} [launch]
 */
/**
 * @typedef {Object} ReaderBrowser
 * @property {HTMLDivElement} container
 * @property {Array<{path: string, method: string, token: string, body: string}>} requests
 * @property {() => number} closeAttempts
 * @property {() => Promise<void>} clickClose
 * @property {() => Promise<void>} waitForBlockedClose
 */
/**
 * @param {ReaderPayload} payload
 * @param {(reader: ReaderBrowser) => Promise<void>} check
 * @param {number} exitStatus
 */
async function withReader(payload, check, exitStatus = 200) {
    await withProcessGlobalTestLock(async () => {
        const browser = new Window({ url: "http://localhost/review" });
        const names = [
            "window",
            "document",
            "navigator",
            "location",
            "localStorage",
            "matchMedia",
            "HTMLElement",
            "Element",
            "Node",
            "MutationObserver",
            "ResizeObserver",
            "IntersectionObserver",
            "getComputedStyle",
            "requestAnimationFrame",
            "cancelAnimationFrame",
            "IS_REACT_ACT_ENVIRONMENT",
            "fetch",
            "close",
            "closed",
        ];
        const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        const requests = [];
        let attempts = 0;
        let root;
        const container = browser.document.createElement("div");
        browser.document.body.append(container);
        try {
            for (const name of names) {
                const value = name === "IS_REACT_ACT_ENVIRONMENT" ? true : browser[name];
                Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
            }
            globalThis.closed = false;
            // Emulate a browser that refuses script-initiated closure of a user-opened tab.
            globalThis.close = () => {
                attempts++;
            };
            globalThis.fetch = (url, options) => {
                requests.push({
                    path: String(url),
                    method: options?.method || "GET",
                    token: options?.headers?.["x-runwield-review-token"] || "",
                    body: options?.body || "",
                });
                return Promise.resolve(
                    new Response(exitStatus === 200 ? "" : "Read session could not stop.", {
                        status: exitStatus,
                    }),
                );
            };
            const { ArtifactReadSurface } = await import(
                `data:text/javascript,${encodeURIComponent(bundle.outputFiles[0].text)}`
            );
            root = createRoot(container);
            await act(() => root.render(<ArtifactReadSurface payload={payload} contentsInitiallyOpen={false} />));
            await check({
                container,
                requests,
                closeAttempts: () => attempts,
                async clickClose() {
                    const button = Array.from(container.querySelectorAll("button")).find((node) =>
                        node.textContent === "Close"
                    );
                    assert(button, "The reader must offer a Close button");
                    await act(async () => {
                        button.click();
                        await Promise.resolve();
                    });
                },
                async waitForBlockedClose() {
                    await act(async () => {
                        await new Promise((resolve) => setTimeout(resolve, 450));
                    });
                },
            });
        } finally {
            if (root) await act(() => root.unmount());
            await browser.happyDOM.close();
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        }
    });
}

const linkedDocument = {
    mode: "standalone",
    launch: "linked",
    token: "linked/token?",
    artifactKind: "document",
    markdown: "# Reference\n\nA linked document.",
};

Deno.test("linked reader Close leaves the document host running", async () => {
    await withReader(linkedDocument, async (reader) => {
        await reader.clickClose();
        await reader.waitForBlockedClose();
        assertEquals(reader.requests.filter((request) => request.path.startsWith("/api/review/exit")), []);
        assertEquals(reader.closeAttempts(), 1);
    });
});

Deno.test("blocked linked reader Close gives honest manual guidance and a Document label", async () => {
    await withReader(linkedDocument, async (reader) => {
        assertEquals(reader.container.querySelector("h1")?.textContent, "Untitled Document");
        await reader.clickClose();
        await reader.waitForBlockedClose();
        const notice = reader.container.querySelector('[role="status"]');
        assert(notice, "A blocked tab close must show manual guidance");
        assertStringIncludes(notice.textContent, "Document view closed.");
        assertStringIncludes(notice.textContent, "Your browser blocked automatic tab closure.");
        assertStringIncludes(notice.textContent, "Close this tab manually.");
        assertStringIncludes(notice.textContent, "Other document links remain available.");
        assertEquals(notice.textContent.includes("read session has ended"), false);
    });
});

Deno.test("standalone reader Close still stops its read session", async () => {
    const { launch: _launch, ...standalone } = linkedDocument;
    await withReader(standalone, async (reader) => {
        await reader.clickClose();
        await reader.waitForBlockedClose();
        assertEquals(reader.requests, [{
            path: "/api/review/exit?token=linked%2Ftoken%3F",
            method: "POST",
            token: standalone.token,
            body: JSON.stringify({ reviewType: "plan" }),
        }]);
        assertEquals(reader.closeAttempts(), 1);
        assertStringIncludes(reader.container.querySelector('[role="status"]')?.textContent, "read session has ended");
    });
});

Deno.test("standalone reader stays open when its read session cannot stop", async () => {
    const { launch: _launch, ...standalone } = linkedDocument;
    await withReader(standalone, async (reader) => {
        await reader.clickClose();
        await reader.waitForBlockedClose();
        assertEquals(reader.container.querySelector('[role="alert"]')?.textContent, "Read session could not stop.");
        assertEquals(reader.container.querySelector('[role="status"]'), null);
        assertEquals(reader.closeAttempts(), 0);
        const closeButton = Array.from(reader.container.querySelectorAll("button")).find((node) =>
            node.textContent === "Close"
        );
        assert(closeButton && !closeButton.disabled, "Close must remain available for retry");
    }, 503);
});
