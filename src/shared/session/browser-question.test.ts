import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import process from "node:process";
import { getCwd } from "../../constants.js";
import { captureForegroundProcess } from "../captured-process.ts";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";

for (const mode of ["answer", "cancel", "bounded-drain"]) {
    test(`browser question shutdown preserves response and terminates: ${mode}`, async () => {
        // A child process makes an uncaught native HTTP lifecycle error fail this test.
        const script = `
import process from "node:process";
let phase = "importing Workspace graph";
console.error("browser question phase: " + phase);
const startupTimer = setTimeout(() => {
    console.error("Browser question startup timed out: " + phase);
    process.exit(1);
}, 30000);
const { startBrowserQuestionServer } = await import(${JSON.stringify(new URL("./browser-question.ts", import.meta.url).href)});
phase = "starting server";
console.error("browser question phase: " + phase);
const entered = Promise.withResolvers();
const payload = "answer delivered ".repeat(5000);
const mode = ${JSON.stringify(mode)};
const question = startBrowserQuestionServer({
    interaction: { type: "text", prompt: "probe" },
    answerQuestion: async (request) => {
        entered.resolve();
        await request.text();
        return new Response(payload);
    },
});
clearTimeout(startupTimer);
phase = "waiting for request handler";
let lifecycleTimer;
const lifecycleDeadline = new Promise((_, reject) => {
    lifecycleTimer = setTimeout(() => reject(new Error("Browser question lifecycle timed out: " + phase)), 5000);
});
try {
await Promise.race([(async () => {
console.error("browser question phase: " + phase);
const upload = mode === "answer" ? "answer=yes" : new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("answer=")); },
});
const response = fetch(new URL("/api/session-question/answer?token=" + question.token, question.url), {
    method: "POST", body: upload, duplex: "half",
}).then(async (value) => ({ status: value.status, text: await value.text() })).catch(() => null);
await entered.promise;
phase = "draining server";
console.error("browser question phase: " + phase);
const shutdownStarted = performance.now();
await question.shutdown({ drain: mode !== "cancel" });
if (mode === "bounded-drain" && performance.now() - shutdownStarted > 4000) {
    throw new Error("Unfinished upload exceeded bounded shutdown allowance");
}
phase = "reading complete response";
console.error("browser question phase: " + phase);
const result = await response;
if (mode === "answer" && (result?.status !== 200 || result.text !== payload)) throw new Error("Answer was truncated");
})(), lifecycleDeadline]);
} finally {
    clearTimeout(lifecycleTimer);
}
console.log("shutdown completed");
process.exit(0);
`;
        const result = await captureForegroundProcess(process.execPath, {
            args: runtimeSourceArgs(["eval", script]),
            cwd: getCwd(),
            // The child reports its phase on either a 30-second startup deadline or
            // a strict five-second lifecycle deadline. This final bound covers a
            // native/event-loop stall that prevents either child timer from firing.
            signal: AbortSignal.timeout(45_000),
        });
        assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
        assertEquals(new TextDecoder().decode(result.stdout).trim(), "shutdown completed");
    });
}
