import { rm, writeFile } from "node:fs/promises";
import { makeTempDirectory } from "../../testing/temp-file.ts";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { assertEquals } from "../../testing/assertions.ts";
import { withRuntimeCommandFixture } from "../../cmd/testing/runtime-command-fixture.ts";
import { defineGitFixture, git } from "../git-test-fixture.ts";
import { resolveReviewTarget } from "./review-target.ts";
import { runStandaloneReview } from "./review-loop.ts";
const fixture = defineGitFixture(async (cwd) => {
    await writeFile(`${cwd}/base.txt`, "base\n");
    await git(cwd, ["add", "."]);
    await git(cwd, ["commit", "-m", "base"]);
});
test("review remains open after failed push and completes when the existing commit is published", async () => {
    await withRuntimeCommandFixture("review-publication-", async ({ setModelResponseFactories }) => {
        const cwd = await fixture.checkout();
        const remote = await makeTempDirectory();
        let browserRun = Promise.resolve();
        let completed = false;
        try {
            await git(remote, ["init", "--bare"]);
            await git(cwd, ["remote", "add", "origin", remote]);
            await git(cwd, ["push", "-u", "origin", "HEAD"]);
            await writeFile(`${cwd}/edit.txt`, "approved\n");
            setModelResponseFactories([
                async () => {
                    await git(cwd, ["add", "."]);
                    await git(cwd, ["commit", "-m", "approved"]);
                    return fauxAssistantMessage("Commit created; push failed.");
                },
                async () => {
                    await git(cwd, ["push"]);
                    return fauxAssistantMessage("Published the existing commit.");
                },
            ]);
            await runStandaloneReview(await resolveReviewTarget(cwd), {
                print: () => {},
                browser: {
                    open: (link) => {
                        browserRun = (async () => {
                            const url = new URL(link);
                            const read = async () =>
                                await (await fetch(new URL(`/api/review/conversation${url.search}`, url))).json();
                            const post = async (endpoint: string) => {
                                const response = await fetch(new URL(`/api/review/${endpoint}${url.search}`, url), {
                                    method: "POST",
                                    headers: { "content-type": "application/json" },
                                    body: JSON.stringify({ reviewAction: "approve_commit" }),
                                });
                                await response.text();
                            };
                            const before = await read();
                            await post("feedback");
                            let retried = false;
                            for (let i = 0; i < 300; i++) {
                                const next = await read();
                                if (next.completed) {
                                    completed = true;
                                    return;
                                }
                                if (next.revision > before.revision && !retried) {
                                    await post("feedback");
                                    retried = true;
                                } else if (next.revision > before.revision + 1) break;
                                await new Promise((resolve) => setTimeout(resolve, 20));
                            }
                            await post("exit");
                        })();
                        browserRun.catch(() => {});
                        return Promise.resolve(true);
                    },
                },
            });
            await browserRun;
            assertEquals(completed, true);
            assertEquals(await git(cwd, ["rev-parse", "HEAD"]), await git(cwd, ["rev-parse", "@{u}"]));
        } finally {
            await rm(cwd, { recursive: true });
            await rm(remote, { recursive: true });
        }
    });
});
