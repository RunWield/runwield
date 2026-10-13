import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { install } from "@sinonjs/fake-timers";
import { notDeepStrictEqual as assertNotEquals } from "node:assert/strict";
import { TuiAgentMascot, type TuiMascotState } from "./agent-mascot.ts";
import { mascotForAgent } from "../mascot/mascot.ts";

test("mascot centers on its stable drawing width across poses and compact widths", () => {
    const renderer = new TuiAgentMascot(() => {});
    try {
        for (const width of [20, 22, 34, 35, 60]) {
            for (const agentName of ["router", "engineer", "architect", "guide", "operator"]) {
                const sprite = mascotForAgent(agentName)!;
                for (const pose of ["idle", "answering", "thinking"] as const) {
                    const lines = renderer.render(width, false, { agentName, sessionId: "one", pose });
                    const original = pose === "thinking" ? sprite.frames[0].lines : sprite[pose].lines;
                    const padding = " ".repeat(Math.max(0, Math.floor((width - sprite.drawingWidth) / 2)));
                    assertEquals(lines, original.map((line) => padding + line.trimEnd()));
                }
                const compact = renderer.render(width, true, { agentName, sessionId: "one", pose: "idle" });
                assertEquals(
                    compact,
                    ["▛▀▀▀▀▀▜", "▙ ▪ ▪ ▟"].map((line) => " ".repeat(Math.floor((width - 7) / 2)) + line),
                );
            }
        }
    } finally {
        renderer.dispose();
    }
});

test("base dot blinks without moving the W body", () => {
    const clock = install({ now: Date.now(), toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    const renderer = new TuiAgentMascot(() => {});
    const sprite = mascotForAgent("router")!;
    const state: TuiMascotState = { agentName: "router", sessionId: "one", pose: "thinking" };
    try {
        assertEquals(sprite.drawingWidth, 17);
        renderer.render(35, false, state);
        clock.tick(sprite.frames[0].duration);
        const dotOn = renderer.render(35, false, state);
        clock.tick(sprite.frames[1].duration);
        const dotOff = renderer.render(35, false, state);
        assertNotEquals(dotOn, dotOff);
        assertEquals(dotOn[7].slice(0, 22).trimEnd(), dotOff[7].slice(0, 22).trimEnd());
        assertEquals(dotOn[1], dotOff[1]);
    } finally {
        renderer.dispose();
        clock.uninstall();
    }
});

test("pausing a running mascot stops its clock until visible again", async () => {
    let renders = 0;
    const renderer = new TuiAgentMascot(() => renders++);
    const state: TuiMascotState = { agentName: "architect", sessionId: "one", pose: "thinking" };
    try {
        const first = renderer.render(35, false, state);
        renderer.pause();
        await new Promise((resolve) => setTimeout(resolve, 120));
        assertEquals(renders, 0);
        assertEquals(renderer.render(35, false, state), first);
        await new Promise((resolve) => setTimeout(resolve, 120));
        assertEquals(renders, 1);
    } finally {
        renderer.dispose();
    }
});

test("mascot clock advances only full active sprites and resets on Session replacement", async () => {
    let renders = 0;
    const mascot = new TuiAgentMascot(() => renders++);
    const state: TuiMascotState = { agentName: "architect", sessionId: "one", pose: "thinking" };
    try {
        const first = mascot.render(20, false, state);
        await new Promise((resolve) => setTimeout(resolve, 95));
        assertEquals(renders, 1);
        assertNotEquals(mascot.render(20, false, state), first);
        assertEquals(mascot.render(20, false, { ...state, sessionId: "two" }), first);
        const compact = mascot.render(20, true, state);
        assertEquals(compact.length, 2);
        await new Promise((resolve) => setTimeout(resolve, 95));
        assertEquals(renders, 1);
        assertEquals(
            mascot.render(20, false, { ...state, pose: "answering" }).map((line) => line.trim()),
            mascotForAgent("architect")!.answering.lines.map((line) => line.trim()),
        );
        assertEquals(mascot.render(20, false, { ...state, agentName: "recorder" }), []);
        mascot.render(20, false, state);
    } finally {
        mascot.dispose();
    }
    await new Promise((resolve) => setTimeout(resolve, 95));
    assertEquals(renders, 1);
});
