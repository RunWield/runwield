import { rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { assertEquals, assertStringIncludes } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { resolveReviewTarget, resolveReviewTargetWithForge } from "./review-target.ts";
import { runStandaloneReview } from "./review-loop.ts";
const fixture = defineGitFixture(async (cwd) => {
    await writeFile(`${cwd}/base.txt`, "base\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
    await git(cwd, ["switch", "-c", "topic"]);
    await writeFile(`${cwd}/base.txt`, "selected head\n");
    await writeFile(`${cwd}/topic-only.txt`, "topic only\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "topic content"]);
    await git(cwd, ["switch", "main"]);
    await git(cwd, ["branch", "--set-upstream-to=main", "topic"]);
});
interface ConversationStatus {
    revision: number;
    rawPatch: string;
    events: Array<{ delta: string; agentName: string }>;
}
async function status(url: URL): Promise<ConversationStatus> {
    const response = await fetch(new URL(`/api/review/conversation${url.search}`, url));
    return await response.json();
}
async function decide(url: URL, endpoint: string, body: Record<string, string | boolean>) {
    const response = await fetch(new URL(`/api/review/${endpoint}${url.search}`, url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    await response.text();
}
test("Engineer uses one real saved Session and refreshes its edited worktree diff", async () => {
    await withRuntimeCommandFixture("standalone-loop-", async ({ setModelResponseFactories }) => {
        const cwd = await fixture.checkout();
        let path = "";
        let browserRun = Promise.resolve();
        const output: string[] = [];
        try {
            const target = await resolveReviewTarget(cwd, "topic");
            setModelResponseFactories([
                () => {
                    path = target.worktree!.path;
                    return fauxAssistantMessage(
                        fauxToolCall("write", {
                            path: "engineer.txt",
                            content: "Engineer change\n",
                        }),
                    );
                },
                () => fauxAssistantMessage("I changed the file."),
                () =>
                    fauxAssistantMessage(
                        fauxToolCall("write", {
                            path: "engineer.txt",
                            content: "Engineer change\nFollow-up edit\n",
                        }),
                    ),
                () => fauxAssistantMessage("I kept the earlier edit and applied the follow-up."),
            ]);
            await runStandaloneReview(target, {
                print: (text) => output.push(text),
                browser: {
                    open: (link) => {
                        browserRun = (async () => {
                            const url = new URL(link);
                            const before = await status(url);
                            for (const [file, contents] of [
                                ["base.txt", "selected head\n"],
                                ["topic-only.txt", "topic only\n"],
                            ]) {
                                const response = await fetch(
                                    new URL(`/api/file-content${url.search}&path=${file}`, url),
                                );
                                assertEquals((await response.json()).newContent, contents);
                            }
                            await decide(url, "deny", { conversationTurn: true, feedback: "Change the file" });
                            for (let i = 0; i < 300; i++) {
                                const next = await status(url);
                                if (next.revision > before.revision) {
                                    try {
                                        assertStringIncludes(next.rawPatch, "+Engineer change");
                                        const response = await fetch(
                                            new URL(`/api/file-content${url.search}&path=engineer.txt`, url),
                                        );
                                        assertEquals((await response.json()).newContent, "Engineer change\n");
                                        assertStringIncludes(
                                            next.events.map((event) => event.delta).join(""),
                                            "I changed the file.",
                                        );
                                        assertEquals(next.events[0].agentName, "Engineer");
                                        await decide(url, "deny", {
                                            conversationTurn: true,
                                            feedback: "Make a follow-up edit",
                                        });
                                        let refreshed = false;
                                        for (let j = 0; j < 300; j++) {
                                            const followup = await status(url);
                                            if (followup.revision > next.revision) {
                                                assertStringIncludes(followup.rawPatch, "+Follow-up edit");
                                                assertStringIncludes(
                                                    followup.events.map((event) => event.delta).join(""),
                                                    "applied the follow-up",
                                                );
                                                refreshed = true;
                                                break;
                                            }
                                            await new Promise((resolve) => setTimeout(resolve, 30));
                                        }
                                        assertEquals(refreshed, true);
                                    } finally {
                                        await decide(url, "exit", {});
                                    }
                                    return;
                                }
                                await new Promise((resolve) => setTimeout(resolve, 30));
                            }
                            await decide(url, "exit", {});
                            throw new Error("Engineer did not refresh the diff.");
                        })();
                        // Attach rejection immediately; the assertion is awaited below.
                        browserRun.catch(async () => {
                            await decide(new URL(link), "exit", {}).catch(() => {});
                        });
                        return Promise.resolve(true);
                    },
                },
            });
            await browserRun;
            assertEquals(await git(cwd, ["status", "--porcelain", "--", "engineer.txt"]), "");
            assertEquals(output.filter((line) => line.startsWith("Engineer Session:")).length, 1);
            assertStringIncludes(output.join("\n"), "wld resume");
            assertStringIncludes(output.join("\n"), "kept:");
        } finally {
            if (path) await rm(path, { recursive: true }).catch(() => {});
            await rm(cwd, { recursive: true });
        }
    });
});
test("cancel review makes no commit, creates no worktree, and starts no Engineer", async () => {
    const cwd = await fixture.checkout();
    let browserRun = Promise.resolve();
    const output: string[] = [];
    try {
        const head = await git(cwd, ["rev-parse", "HEAD"]);
        const worktrees = await git(cwd, ["worktree", "list", "--porcelain"]);
        await runStandaloneReview(await resolveReviewTarget(cwd, "topic"), {
            print: (text) => output.push(text),
            browser: {
                open: (link) => {
                    browserRun = decide(new URL(link), "exit", {});
                    return Promise.resolve(true);
                },
            },
        });
        await browserRun;
        assertEquals(await git(cwd, ["rev-parse", "HEAD"]), head);
        assertEquals(await git(cwd, ["worktree", "list", "--porcelain"]), worktrees);
        assertEquals(
            output.some((line) => line.startsWith("Engineer Session:")),
            false,
        );
        assertStringIncludes(output.join("\n"), "No review worktree");
    } finally {
        await rm(cwd, { recursive: true });
    }
});

import { makeForgeFixture } from "./forge-test-fixture.ts";
test("Post comments submits once, shows completion, and ends without Engineer workspace", async () => {
    const cwd = await fixture.checkout();
    let browserRun = Promise.resolve();
    try {
        const forge = await makeForgeFixture(cwd);
        const target = await resolveReviewTargetWithForge(
            cwd,
            "https://github.com/org/repo/pull/1",
            forge.runtime,
            () => forge.runtime,
        );
        await runStandaloneReview(target, {
            print: () => {},
            browser: {
                open: (link) => {
                    browserRun = (async () => {
                        const url = new URL(link);
                        await decide(url, "feedback", { reviewAction: "post_comments", feedback: "Review notes" });
                        for (let i = 0; i < 150; i++) {
                            const response = await fetch(new URL(`/api/review/conversation${url.search}`, url));
                            const next = await response.json();
                            if (next.completed) {
                                assertStringIncludes(next.resultMessage, "Comments posted");
                                return;
                            }
                            await new Promise((resolve) => setTimeout(resolve, 20));
                        }
                        throw new Error("No completed result.");
                    })();
                    browserRun.catch(async () => {
                        await decide(new URL(link), "exit", {}).catch(() => {});
                    });
                    return Promise.resolve(true);
                },
            },
        });
        await browserRun;
        assertEquals(forge.submissions.length, 1);
        assertEquals(target.worktree, undefined);
    } finally {
        await rm(cwd, { recursive: true });
    }
});
test("a changed PR head refuses submission, refreshes the diff, and stays open for cancellation", async () => {
    const cwd = await fixture.checkout();
    let browserRun = Promise.resolve();
    const output: string[] = [];
    try {
        const forge = await makeForgeFixture(cwd);
        const target = await resolveReviewTargetWithForge(
            cwd,
            "https://github.com/org/repo/pull/1",
            forge.runtime,
            () => forge.runtime,
        );
        await runStandaloneReview(target, {
            print: (text) => output.push(text),
            browser: {
                open: (link) => {
                    browserRun = (async () => {
                        const url = new URL(link);
                        const before = await status(url);
                        const selectedContent = await fetch(
                            new URL(`/api/file-content${url.search}&path=base.txt`, url),
                        );
                        assertEquals((await selectedContent.json()).newContent, "selected head\n");
                        await git(cwd, ["switch", "topic"]);
                        await writeFile(`${cwd}/moved.txt`, "remote head change\n");
                        await git(cwd, ["add", "."]);
                        await git(cwd, ["commit", "-m", "remote move"]);
                        const moved = await git(cwd, ["rev-parse", "HEAD"]);
                        await git(cwd, ["update-ref", "refs/pull/1/head", moved]);
                        await git(cwd, ["switch", "main"]);
                        forge.moveHead(moved);
                        await decide(url, "feedback", { reviewAction: "post_comments", feedback: "review notes" });
                        for (let i = 0; i < 200; i++) {
                            const next = await status(url);
                            if (next.revision > before.revision) {
                                try {
                                    assertStringIncludes(next.rawPatch, "+remote head change");
                                    const selectedContent = await fetch(
                                        new URL(`/api/file-content${url.search}&path=moved.txt`, url),
                                    );
                                    assertEquals((await selectedContent.json()).newContent, "remote head change\n");
                                } finally {
                                    await decide(url, "exit", {});
                                }
                                return;
                            }
                            await new Promise((resolve) => setTimeout(resolve, 20));
                        }
                        await decide(url, "exit", {});
                        throw new Error("Review did not refresh after refusal.");
                    })();
                    browserRun.catch(async () => {
                        await decide(new URL(link), "exit", {}).catch(() => {});
                    });
                    return Promise.resolve(true);
                },
            },
        });
        await browserRun;
        assertEquals(forge.submissions.length, 0);
        assertStringIncludes(output.join("\n"), "head changed");
    } finally {
        await rm(cwd, { recursive: true });
    }
});
