import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { animations, mascotRoleForAgent, terminalLines } from "./frames.ts";
import { mascotPose, MASCOTS } from "./mascot.ts";

test("mascot identities follow aliases, hidden agents and inherited delegation", () => {
    for (
        const [agent, expected] of [
            ["Guide", "guide"],
            ["Slicer", "planner"],
            ["Init", "base"],
            ["Router", "base"],
            ["Frontend Engineer", "engineer"],
            ["validation-repair-engineer", "engineer"],
            ["reviewer-feedback-engineer", "engineer"],
            ["custom-specialist", "base"],
        ]
    ) assertEquals(mascotRoleForAgent(agent), expected);
    assertEquals(mascotRoleForAgent("delegated", "guide"), "guide");
    assertEquals(mascotRoleForAgent("delegated", "frontend-engineer"), "engineer");
    assertEquals(mascotRoleForAgent("delegated", "router"), "base");
    assertEquals(mascotRoleForAgent("delegated", "init"), "base");
    assertEquals(mascotRoleForAgent("delegated"), undefined);
    for (const agent of ["recorder", "tester"]) {
        assertEquals(mascotRoleForAgent(agent), undefined);
        assertEquals(mascotRoleForAgent("delegated", agent), undefined);
    }
});

test("all approved frames stay one-bit and round trip through terminal half blocks", () => {
    for (const animation of animations) {
        for (const pixels of [...animation.frames.map((f) => f.pixels), animation.idle, animation.answering]) {
            assertEquals(pixels.length, 18);
            assert(pixels.every((row) => /^[.#]{20}$/.test(row)));
            const decoded = terminalLines(pixels).flatMap((line) => [
                [...line].map((char) => "▀█".includes(char) ? "#" : ".").join(""),
                [...line].map((char) => "▄█".includes(char) ? "#" : ".").join(""),
            ]);
            assertEquals(decoded, pixels);
        }
    }
    const base = animations.find((a) => a.role === "base")!;
    assertEquals(base.frames.map((f) => f.duration), Array(8).fill(300));
    assertEquals(base.frames.map((f) => f.pixels[14][15]), ["#", "#", ".", ".", "#", "#", ".", "."]);
});

test("waiting and idle override answering; activity does not imply estimated progress", () => {
    assertEquals(mascotPose({ busy: true }), "thinking");
    assertEquals(mascotPose({ busy: true, answering: true }), "answering");
    assertEquals(mascotPose({ busy: true, answering: true, waiting: true }), "idle");
    assertEquals(mascotPose({ busy: false, answering: true }), "idle");
});

test("mascot drawing widths include every animation frame and still pose", () => {
    for (const mascot of MASCOTS) {
        const widths = [...mascot.frames, mascot.idle, mascot.answering]
            .flatMap((frame) => frame.lines.map((line) => line.trimEnd().length));
        assertEquals(mascot.drawingWidth, Math.max(...widths), mascot.role);
    }
});
