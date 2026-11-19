import { assertEquals } from "../../testing/assertions.ts";
import { test } from "node:test";
import { runOnboardCommand } from "./index.ts";

test("wld onboard refuses a non-interactive terminal without starting a Session", async () => {
    let started = false;
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
        await runOnboardCommand([], {
            sessionPort: {
                startInteractiveSession: () => {
                    started = true;
                    return Promise.resolve();
                },
            },
        });
    } finally {
        console.error = originalError;
    }

    assertEquals(started, false);
    assertEquals(errors, ["[RunWield] wld onboard requires an interactive terminal."]);
});
