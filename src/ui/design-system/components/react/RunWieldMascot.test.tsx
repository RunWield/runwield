import { test } from "node:test";
import { notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../../../../testing/assertions.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunWieldMascot } from "./RunWieldMascot.tsx";
import { mascotForAgent } from "../../../mascot/mascot.ts";
import { Window } from "happy-dom";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

test("browser mascot preserves identity, static answer pose and accessible written labels", () => {
    const html = renderToStaticMarkup(createElement(RunWieldMascot, {
        agentName: "delegated",
        parentAgentName: "ideator",
        pose: "answering",
    }));
    assertStringIncludes(html, 'data-agent-mascot="ideator"');
    assertStringIncludes(html, 'aria-hidden="true"');
    assertStringIncludes(html, 'width="60" height="54"');
    assertStringIncludes(html, mascotForAgent("ideator")!.answering.path);
    assertEquals(renderToStaticMarkup(createElement(RunWieldMascot, { agentName: "recorder" })), "");
    assertEquals(renderToStaticMarkup(createElement(RunWieldMascot, { agentName: "tester" })), "");
});

test("browser mascot stops offscreen, hidden, reduced-motion and unmounted", async () => {
    const browser = new Window();
    let intersect = (_visible: boolean) => {};
    let motionChange = () => {};
    let reduced = false;
    let hidden = false;
    class Observer {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
            intersect = (visible) => callback([{ isIntersecting: visible }]);
        }
        observe() {}
        disconnect() {
            intersect = () => {};
        }
    }
    const env = {
        document: browser.document,
        IntersectionObserver: Observer,
        matchMedia: () => ({
            get matches() {
                return reduced;
            },
            addEventListener: (_name: string, callback: () => void) => {
                motionChange = callback;
            },
            removeEventListener: () => {
                motionChange = () => {};
            },
        }),
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    const saved = new Map(Object.keys(env).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    let renderer: ReactTestRenderer | undefined;
    try {
        Object.defineProperty(browser.document, "hidden", { get: () => hidden });
        for (const [key, value] of Object.entries(env)) {
            Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        }
        await act(() => {
            renderer = create(createElement(RunWieldMascot, { agentName: "architect", pose: "thinking" }), {
                createNodeMock: () => browser.document.createElementNS("http://www.w3.org/2000/svg", "svg"),
            });
        });
        const path = () => renderer!.root.findByType("path").props.d;
        const first = path();
        await act(() => {
            intersect(true);
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 95));
        });
        assertNotEquals(path(), first);
        await act(() => {
            intersect(false);
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 95));
        });
        assertEquals(path(), first);
        await act(() => {
            hidden = true;
            intersect(true);
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 95));
        });
        assertEquals(path(), first);
        await act(() => {
            hidden = false;
            reduced = true;
            motionChange();
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 95));
        });
        assertEquals(path(), first);
        await act(() => {
            reduced = false;
            motionChange();
        });
    } finally {
        await act(() => renderer?.unmount());
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await browser.happyDOM.close();
    }
});
