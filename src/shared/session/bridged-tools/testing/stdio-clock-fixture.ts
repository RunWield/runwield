import { statSync, writeFileSync } from "node:fs";
import process from "node:process";
import { install } from "@sinonjs/fake-timers";
import { runRunWieldMcpStdioTransport } from "../stdio-transport.ts";

// Advance only this subprocess's clock while the real HTTP/stdio tool call waits.
// Production uses its normal transports and timeout policy without injection.
const advancePath = process.argv[2];
const advancedPath = process.argv[3];
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const time = install({ now: Date.now(), toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
const timer = realSetInterval(() => {
    try {
        statSync(advancePath);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
    }
    realClearInterval(timer);
    time.tick(61_000);
    writeFileSync(advancedPath, "advanced");
}, 10);
try {
    await runRunWieldMcpStdioTransport();
} finally {
    time.uninstall();
    realClearInterval(timer);
}
