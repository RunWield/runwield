import type { PRRuntime } from "@plannotator/shared/pr-types.ts";
import { git } from "../git-test-fixture.ts";
/** Fake only Forge subprocesses. Fetch refs from the real local Git repository. */
export async function makeForgeFixture(cwd: string) {
    const base = await git(cwd, ["rev-parse", "main"]);
    let head = await git(cwd, ["rev-parse", "topic"]);
    await git(cwd, ["update-ref", "refs/pull/1/head", head]);
    await git(cwd, ["remote", "add", "origin", cwd]);
    await git(cwd, ["config", "remote.origin.pushurl", "https://github.com/org/repo.git"]);
    const submissions: string[] = [];
    const runtime: PRRuntime = {
        runCommand: (_cmd, args) =>
            Promise.resolve({
                exitCode: 0,
                stderr: "",
                stdout:
                    args[0] === "pr" && args[1] === "view"
                        ? JSON.stringify({
                              id: "node",
                              title: "Review title",
                              body: "Review body",
                              author: { login: "user" },
                              baseRefName: "main",
                              headRefName: "topic",
                              baseRefOid: base,
                              headRefOid: head,
                              url: "https://github.com/org/repo/pull/1",
                          })
                        : args[0] === "repo"
                          ? "main"
                          : "",
            }),
        runCommandWithInput: (_cmd, _args, input) => {
            submissions.push(input);
            return Promise.resolve({ exitCode: 0, stderr: "", stdout: "{}" });
        },
    };
    return {
        runtime,
        submissions,
        moveHead: (value: string) => {
            head = value;
        },
    };
}
