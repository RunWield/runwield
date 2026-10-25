import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { assertEquals } from "../../../testing/assertions.ts";
import { defineCommittedGitFixture, git } from "../../../shared/git-test-fixture.ts";
import { DatabaseSync } from "../../../shared/sqlite.ts";
import { PHASES, REQUIRED_HOST_RUNS } from "./evidence.ts";
import { captureSnapshot, collectEvidence, collectPrivacyEvidence } from "./collector.ts";
import { evaluateEvidence } from "./evaluator.ts";
import { METADATA } from "./evidence-test-fixture.ts";

const base = defineCommittedGitFixture();
const SENTINEL = "ordinary-private-message-857ac66b";
async function write(root: string, path: string, text: string): Promise<void> {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
}
async function withWorld(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "connect-acceptance-collector-"));
    try {
        await rename(await base.checkout(), join(root, "fixture"));
        await write(root, "runwield-home/.wld/settings.json", "{}");
        await write(root, "run.json", JSON.stringify(METADATA));
        await write(root, "markers/ci-runs", "");
        await write(root, "markers/ci-finished", "");
        for (const path of [
            "sentinel-binaries.log",
            "proxy-sink.log",
            "logs/http.jsonl",
            "logs/processes.jsonl",
            "logs/plugins.jsonl",
        ])
            await write(root, path, "");
        await write(root, "shim-argv.jsonl", '["attached","mcp"]\n["attached","status"]\n');
        for (const run of REQUIRED_HOST_RUNS)
            await write(
                root,
                `logs/claude/${run}.jsonl`,
                JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\n",
            );
        await write(
            root,
            "logs/claude/request.jsonl",
            JSON.stringify({
                type: "assistant",
                message: {
                    content: [
                        {
                            type: "tool_use",
                            id: "tool-1",
                            name: "mcp__plugin_runwield_runwield__activate",
                            input: { operationId: "op-1" },
                        },
                        {
                            type: "tool_use",
                            id: "tool-2",
                            name: "mcp__another_server__activate",
                            input: { operationId: "not-runwield" },
                        },
                    ],
                },
            }) + "\n",
        );
        await write(
            root,
            "logs/claude/inactive-before.jsonl",
            JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: SENTINEL }] } }) +
                "\n" +
                JSON.stringify({ type: "result", subtype: "success", is_error: false }) +
                "\n",
        );
        await write(
            root,
            "logs/claude/stale-adapter.jsonl",
            [
                {
                    type: "assistant",
                    message: {
                        content: [
                            {
                                type: "tool_use",
                                id: "stale-tool",
                                name: "mcp__plugin_runwield_runwield__activate",
                                input: { operationId: "stale-operation" },
                            },
                        ],
                    },
                },
                {
                    type: "user",
                    message: {
                        content: [
                            {
                                type: "tool_result",
                                tool_use_id: "stale-tool",
                                content: [
                                    {
                                        type: "text",
                                        text: JSON.stringify({
                                            ok: false,
                                            rejection: { code: "incompatible_adapter" },
                                        }),
                                    },
                                ],
                            },
                        ],
                    },
                },
            ]
                .map((row) => JSON.stringify(row))
                .join("\n") + "\n",
        );
        const snapshot = await captureSnapshot(root);
        assertEquals(snapshot.errors, []);
        for (const phase of PHASES) await write(root, `snapshots/${phase}.json`, JSON.stringify(snapshot));
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("snapshot reads an installed runtime file symlink without changing the world", async () => {
    await withWorld(async (root) => {
        const target = "runwield-home/.local/share/mnemoteca/lib/libonnxruntime.1.dylib";
        const link = "runwield-home/.local/share/mnemoteca/lib/libonnxruntime.dylib";
        await write(root, target, "binary runtime bytes\u0000");
        await symlink("libonnxruntime.1.dylib", join(root, link));
        const snapshot = await captureSnapshot(root);
        assertEquals(snapshot.errors, []);
        assert(snapshot.files.some((file) => file.path === link));
        assertEquals(
            snapshot.files.find((file) => file.path === link)?.sha256,
            snapshot.files.find((file) => file.path === target)?.sha256,
        );
        assertEquals(await captureSnapshot(root), snapshot);
    });
});

test("privacy scans resolved file-link bytes rather than ignoring the link", async () => {
    await withWorld(async (root) => {
        await write(root, "linked-bytes.bin", `binary\u0000${SENTINEL}\u0000`);
        await symlink(join(root, "linked-bytes.bin"), join(root, "runwield-home/runtime-link.bin"));
        const result = await collectPrivacyEvidence(root, [SENTINEL]);
        assertEquals(result.errors, []);
        assertEquals(result.leaks, ["runwield-home/runtime-link.bin"]);
    });
});

test("privacy can prove absence through a readable file symlink", async () => {
    await withWorld(async (root) => {
        await write(root, "linked-bytes.bin", "clean runtime bytes");
        await symlink(join(root, "linked-bytes.bin"), join(root, "runwield-home/runtime-link.bin"));
        assertEquals(await collectPrivacyEvidence(root, [SENTINEL]), { leaks: [], errors: [] });
    });
});

test("directory links fail closed instead of skipping their contents", async () => {
    await withWorld(async (root) => {
        await write(root, "linked-directory/private.bin", SENTINEL);
        await symlink(join(root, "linked-directory"), join(root, "runwield-home/directory-link"));
        const result = await collectPrivacyEvidence(root, [SENTINEL]);
        assertEquals(result.errors, ["runwield-home/directory-link: unreadable"]);
        assert((await captureSnapshot(root)).errors.includes("runwield-home/directory-link: unreadable"));
    });
});

test("collector reads real Git state, snapshots, and Claude tool IDs without treating chat or other servers as evidence", async () => {
    await withWorld(async (root) => {
        const result = await collectEvidence(root, [SENTINEL]);
        assertEquals(result.errors, []);
        assertEquals(result.privacy, { leaks: [], errors: [] });
        assertEquals(
            result.tools.filter((tool) => tool.run === "request"),
            [{ run: "request", toolId: "tool-1", operation: "activate", operationId: "op-1" }],
        );
        assertEquals(result.toolResults, [
            {
                run: "stale-adapter",
                toolId: "stale-tool",
                body: { ok: false, rejection: { code: "incompatible_adapter" } },
            },
        ]);
        assertEquals(evaluateEvidence(result).checks.find((row) => row.id === "stale-adapter")?.outcome, "pass");
        assertEquals(result.snapshots.initial?.git?.branch, "main");
        assert(result.snapshots.initial?.git?.refs["refs/heads/main"]);
        assertEquals(result.snapshots.initial?.ciRuns, []);
        // Read-only collection does not create Core artifacts in an uninitialized fixture.
        assertEquals((await captureSnapshot(root)).files, result.snapshots.initial?.files);
    });
});

for (const path of [
    "runwield-home/.wld/workflow-metrics/project/metrics.jsonl",
    "fixture/docs/work-records/record.md",
]) {
    test(`privacy scan reports a planted leak in ${path}`, async () => {
        await withWorld(async (root) => {
            await write(root, path, SENTINEL);
            const result = await collectPrivacyEvidence(root, [SENTINEL]);
            assertEquals(result.leaks, [path]);
            assertEquals(result.errors, []);
        });
    });
}

test("privacy scan finds a sentinel inside a real binary SQLite database", async () => {
    await withWorld(async (root) => {
        const path = "runwield-home/mnemoteca.db";
        const db = new DatabaseSync(join(root, path));
        try {
            db.exec("CREATE TABLE memories(body TEXT)");
            db.prepare("INSERT INTO memories VALUES (?)").run(SENTINEL);
        } finally {
            db.close();
        }
        const bytes = await readFile(join(root, path));
        assertEquals(bytes.subarray(0, 16).toString(), "SQLite format 3\0");
        assertEquals((await collectPrivacyEvidence(root, [SENTINEL])).leaks, [path]);
    });
});

test("privacy scan reports a sentinel present only in an earlier commit", async () => {
    await withWorld(async (root) => {
        await write(root, "fixture/old.md", SENTINEL);
        await git(join(root, "fixture"), ["add", "old.md"]);
        await git(join(root, "fixture"), ["commit", "-m", "earlier content"]);
        await write(root, "fixture/old.md", "Current clean content\n");
        await git(join(root, "fixture"), ["add", "old.md"]);
        await git(join(root, "fixture"), ["commit", "-m", "current content"]);
        const result = await collectPrivacyEvidence(root, [SENTINEL]);
        assertEquals(result.errors, []);
        assertEquals(result.leaks.length, 1);
        assert(result.leaks[0].startsWith("fixture/git/blob/"));
    });
});

test("privacy scan includes commits retained only in the reflog after a branch is removed", async () => {
    await withWorld(async (root) => {
        const repo = join(root, "fixture");
        await git(repo, ["switch", "-c", "temporary"]);
        await write(root, "fixture/old.md", SENTINEL);
        await git(repo, ["add", "old.md"]);
        await git(repo, ["commit", "-m", "temporary content"]);
        await git(repo, ["switch", "main"]);
        await git(repo, ["branch", "-D", "temporary"]);
        const result = await collectPrivacyEvidence(root, [SENTINEL]);
        assertEquals(result.errors, []);
        assertEquals(result.leaks.length, 1);
        assert(result.leaks[0].startsWith("fixture/git/blob/"));
    });
});

interface PlantedLog {
    name: string;
    path: string;
    content: string;
    check: string;
}
const logs: PlantedLog[] = [
    {
        name: "model sentinel process",
        path: "sentinel-binaries.log",
        content: "claude --model\n",
        check: "no-core-model-calls",
    },
    {
        name: "provider proxy request",
        path: "proxy-sink.log",
        content: "api.anthropic.com:443\n",
        check: "no-core-model-calls",
    },
    {
        name: "mutating wld invocation",
        path: "shim-argv.jsonl",
        content: '["attached","activate"]\n',
        check: "read-only-driver",
    },
];
for (const log of logs)
    test(`collector exposes a planted ${log.name}`, async () => {
        await withWorld(async (root) => {
            await write(root, log.path, log.content);
            const result = await collectEvidence(root, [SENTINEL]);
            assertEquals(result.errors, []);
            assertEquals(evaluateEvidence(result).checks.find((row) => row.id === log.check)?.outcome, "fail");
            if (log.path === "sentinel-binaries.log") assertEquals(result.modelProcesses, ["claude --model"]);
            if (log.path === "proxy-sink.log") assertEquals(result.proxyHosts, ["api.anthropic.com:443"]);
            if (log.path === "shim-argv.jsonl") assertEquals(result.shimArgv, [["attached", "activate"]]);
        });
    });

for (const path of [
    "sentinel-binaries.log",
    "proxy-sink.log",
    "shim-argv.jsonl",
    "logs/claude/request.jsonl",
    "snapshots/ci-resumed.json",
]) {
    test(`missing ${path} is not negative evidence`, async () => {
        await withWorld(async (root) => {
            await rm(join(root, path));
            const result = await collectEvidence(root, [SENTINEL]);
            assert(result.errors.some((error) => error.includes(path)));
            assertEquals(evaluateEvidence(result).outcome, "fail");
        });
    });
}

test("malformed audit log cannot count as an empty successful check", async () => {
    await withWorld(async (root) => {
        await write(root, "shim-argv.jsonl", '{"not":"argv"}\n');
        const result = await collectEvidence(root, [SENTINEL]);
        assert(result.errors.some((error) => error.includes("malformed argv")));
        assertEquals(evaluateEvidence(result).outcome, "fail");
    });
});

test("malformed snapshot is reported instead of reaching the evaluator as trusted data", async () => {
    await withWorld(async (root) => {
        await write(root, "snapshots/ci-resumed.json", '{"files": [null], "errors": [], "ciRuns": [], "git": {}}');
        const result = await collectEvidence(root, [SENTINEL]);
        assert(result.errors.some((error) => error.includes("incomplete snapshot")));
        assertEquals(result.snapshots["ci-resumed"], undefined);
    });
});

test("changed current state cannot reuse an earlier final snapshot", async () => {
    await withWorld(async (root) => {
        await write(root, "fixture/README.md", "Changed\n");
        const result = await collectEvidence(root, [SENTINEL]);
        assert(result.errors.includes("snapshots/inactive-after.json: differs from current state"));
    });
});

test("unreadable Git and broken file links fail privacy instead of reporting absence", async () => {
    await withWorld(async (root) => {
        await symlink(join(root, "absent"), join(root, "runwield-home/unreadable-link"));
        await rename(join(root, "fixture/.git"), join(root, "saved-git"));
        const result = await collectPrivacyEvidence(root, [SENTINEL]);
        assert(result.errors.includes("runwield-home/unreadable-link: unreadable"));
        assert(result.errors.includes("fixture/git: cannot inspect history"));
    });
});

test("privacy scan refuses to claim absence without a sentinel", async () => {
    await withWorld(async (root) => {
        assertEquals((await collectPrivacyEvidence(root, [])).errors, ["privacy: missing sentinel"]);
    });
});

test("privacy scan finds a sentinel in a commit message, not just file blobs", async () => {
    await withWorld(async (root) => {
        await git(join(root, "fixture"), ["commit", "--allow-empty", "-m", SENTINEL]);
        const result = await collectPrivacyEvidence(root, [SENTINEL]);
        assertEquals(result.errors, []);
        assert(result.leaks.some((path) => path.startsWith("fixture/git/commit/")));
    });
});

test("privacy scan includes an unreferenced commit with no reflog", async () => {
    await withWorld(async (root) => {
        const repo = join(root, "fixture");
        await write(root, "fixture/orphan.md", SENTINEL);
        await git(repo, ["add", "orphan.md"]);
        const tree = await git(repo, ["write-tree"]);
        await git(repo, ["commit-tree", tree, "-m", "unreferenced content"]);
        await rm(join(repo, "orphan.md"));
        const result = await collectPrivacyEvidence(root, [SENTINEL]);
        assertEquals(result.errors, []);
        assert(result.leaks.some((path) => path.startsWith("fixture/git/blob/")));
    });
});

test("collector reads published Plan and Work Record bytes without checking out the delivery branch", async () => {
    await withWorld(async (root) => {
        const repo = join(root, "fixture");
        await git(repo, ["switch", "-c", "feature"]);
        await write(root, "fixture/docs/plans/feature.md", "---\nplanId: plan-id\nstatus: reviewed\n---\n# Plan\n");
        await write(
            root,
            "fixture/docs/work-records/record.md",
            "---\nkind: work_record\nrecordId: record-id\n---\n# Record\n",
        );
        await git(repo, ["add", "docs"]);
        await git(repo, ["commit", "-m", "published artifacts"]);
        const commit = await git(repo, ["rev-parse", "HEAD"]);
        await git(repo, ["switch", "main"]);
        await write(
            root,
            "runwield-home/.wld/attached/project/workflows/workflow.json",
            JSON.stringify({
                plan: { planId: "plan-id", planName: "feature" },
                closure: { workRecord: { path: "docs/work-records/record.md" } },
            }),
        );
        await write(
            root,
            "fixture/.wld/internal/controller/plans/plan-id.json",
            JSON.stringify({
                planId: "plan-id",
                planName: "feature",
                state: { publicationReceipt: { publishedCommit: commit } },
            }),
        );
        const result = await captureSnapshot(root);
        assertEquals(result.errors, []);
        assertEquals(result.git?.branch, "main");
        assert(
            result.files.some(
                (file) => file.path === `published/${commit}/docs/plans/feature.md` && file.text?.includes("plan-id"),
            ),
        );
        assert(
            result.files.some(
                (file) =>
                    file.path === `published/${commit}/docs/work-records/record.md` && file.text?.includes("record-id"),
            ),
        );
        assertEquals(
            result.files.some((file) => file.path === "fixture/docs/work-records/record.md"),
            false,
        );
    });
});

test("nested tool-shaped arguments are not real host tool use", async () => {
    await withWorld(async (root) => {
        await write(
            root,
            "logs/claude/request.jsonl",
            JSON.stringify({
                type: "assistant",
                message: {
                    content: [
                        {
                            type: "tool_use",
                            id: "shell",
                            name: "Bash",
                            input: {
                                nested: {
                                    type: "tool_use",
                                    id: "forged",
                                    name: "mcp__runwield__activate",
                                    input: { operationId: "forged" },
                                },
                            },
                        },
                    ],
                },
            }) + "\n",
        );
        const result = await collectEvidence(root, [SENTINEL]);
        assertEquals(
            result.tools.filter((tool) => tool.run === "request"),
            [],
        );
    });
});
