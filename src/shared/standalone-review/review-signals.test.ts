import process from "node:process";
import { rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { resolveReviewTarget } from "./review-target.ts";
import { runStandaloneReview } from "./review-loop.ts";

const fixture = defineGitFixture(async (cwd) => {
    await writeFile(`${cwd}/file.txt`, "base\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
    await git(cwd, ["branch", "topic"]);
});

for (const hangup of [false, true]) {
    test(
        hangup
            ? "terminal hangup closes the Engineer Session and settles its worktree"
            : "unsupported signals do not prevent review startup",
        async () => {
            await withRuntimeCommandFixture("review-signals-", async ({ setModelResponseFactories }) => {
                const cwd = await fixture.checkout();
                const target = await resolveReviewTarget(cwd, "topic");
                const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
                const previous = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
                const add = process.on;
                const output: string[] = [];
                let browserRun = Promise.resolve();
                // Unsupported host signals still leave SIGINT on the native event emitter.
                process.on = function (event: string | symbol, listener: () => void) {
                    if (!hangup && (event === "SIGTERM" || event === "SIGHUP")) {
                        throw new Error("Signal not supported");
                    }
                    return add.call(this, event, listener);
                };
                try {
                    setModelResponseFactories([
                        async () => {
                            await writeFile(`${target.worktree!.path}/file.txt`, "Engineer edit\n");
                            return fauxAssistantMessage("Edited.");
                        },
                    ]);
                    await runStandaloneReview(target, {
                        print: (text) => output.push(text),
                        browser: {
                            open: (link) => {
                                browserRun = (async () => {
                                    const url = new URL(link);
                                    if (hangup) {
                                        const response = await fetch(new URL(`/api/review/deny${url.search}`, url), {
                                            method: "POST",
                                            headers: { "content-type": "application/json" },
                                            body: JSON.stringify({
                                                conversationTurn: true,
                                                feedback: "Edit the file",
                                            }),
                                        });
                                        await response.text();
                                        for (let i = 0; i < 300; i++) {
                                            const response = await fetch(
                                                new URL(`/api/review/conversation${url.search}`, url),
                                            );
                                            if ((await response.json()).revision > 0) {
                                                if (process.listenerCount("SIGHUP") <= previous.get("SIGHUP")!.length) {
                                                    throw new Error("Terminal hangup has no cleanup handler");
                                                }
                                                process.emit("SIGHUP");
                                                return;
                                            }
                                            await new Promise((resolve) => setTimeout(resolve, 20));
                                        }
                                        throw new Error("Engineer did not refresh");
                                    }
                                    assertEquals(process.listenerCount("SIGINT"), previous.get("SIGINT")!.length + 1);
                                    process.emit("SIGINT");
                                })();
                                browserRun.catch(() => process.emit("SIGINT"));
                                return Promise.resolve(true);
                            },
                        },
                    });
                    await browserRun;
                    for (const signal of signals) assertEquals(process.listeners(signal), previous.get(signal));
                    assertStringIncludes(
                        output.join("\n"),
                        hangup ? "Resume Engineer: wld resume" : "No review worktree",
                    );
                    if (hangup) assertStringIncludes(output.join("\n"), "Review worktree kept:");
                } finally {
                    process.on = add;
                    if (target.worktree) {
                        await rm(target.worktree.path, { recursive: true }).catch(() => {});
                    }
                    await rm(cwd, { recursive: true });
                }
            });
        },
    );
}
