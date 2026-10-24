import { test } from "node:test";
import { ok as assert, deepStrictEqual as equal, rejects, throws } from "node:assert/strict";
import { cp, readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { AcceptanceWorld, PrerequisiteError } from "./world.ts";
import { withExternalClaude, CHECKOUT, UNAUTHENTICATED_CLAUDE } from "./runtime-test-fixture.ts";

test("world starts with a clean committed uninitialized project and isolated Core settings", async () => {
    await withExternalClaude(UNAUTHENTICATED_CLAUDE, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        try {
            const snapshot = await world.snapshot("initial", null);
            equal(snapshot.errors, []);
            equal(snapshot.ciRuns, []);
            equal(snapshot.git?.branch, "main");
            equal(snapshot.git?.status, "");
            equal(
                snapshot.files.some(
                    (file) => file.path.startsWith("fixture/.wld/") || file.path === "fixture/AGENTS.md",
                ),
                false,
            );
            const settings = JSON.parse(await readFile(join(root, "runwield-home/.wld/settings.json"), "utf8"));
            equal(settings, { verification_command: "sh ./check.sh", codereview: "always", workflowMetrics: true });
            const reviewer = await readFile(
                join(root, "runwield-home/.wld/agents/shared-practice/review-practice.md"),
                "utf8",
            );
            assert(reviewer.includes("acceptance-notes"));
            assert((await stat(root)).mode % 512 === 0o700);
        } finally {
            await world.close();
        }
    });
});

test("stale and current marketplaces preserve packaging but declare different contracts and versions", async () => {
    await withExternalClaude(UNAUTHENTICATED_CLAUDE, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        try {
            const plugin = "src/attached/claude/plugin";
            for (const name of ["marketplace", "stale-marketplace"]) {
                const marketplace = JSON.parse(
                    await readFile(join(root, name, ".claude-plugin/marketplace.json"), "utf8"),
                );
                equal(marketplace.name, "runwield");
                equal(marketplace.plugins[0].source, "./src/attached/claude/plugin");
            }
            equal(
                JSON.parse(await readFile(join(root, "marketplace", plugin, "runwield-adapter.json"), "utf8"))
                    .adapterContract,
                1,
            );
            equal(
                JSON.parse(await readFile(join(root, "stale-marketplace", plugin, "runwield-adapter.json"), "utf8"))
                    .adapterContract,
                0,
            );
            const current = JSON.parse(
                await readFile(join(root, "marketplace", plugin, ".claude-plugin/plugin.json"), "utf8"),
            );
            const stale = JSON.parse(
                await readFile(join(root, "stale-marketplace", plugin, ".claude-plugin/plugin.json"), "utf8"),
            );
            assert(current.version !== stale.version);
        } finally {
            await world.close();
        }
    });
});

test("world refuses to overwrite a nonempty output directory", async () => {
    await withExternalClaude(UNAUTHENTICATED_CLAUDE, async (root, claude) => {
        await mkdir(root);
        await writeFile(join(root, "user-work"), "keep");
        await rejects(AcceptanceWorld.create(root, CHECKOUT, claude), /new or empty/);
        equal(await readFile(join(root, "user-work"), "utf8"), "keep");
        equal(await readdir(root), ["user-work"]);
    });
});

test("read-only carrier uses the isolated HOME and records only the real status invocation", async () => {
    await withExternalClaude(UNAUTHENTICATED_CLAUDE, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        try {
            const before = await world.snapshot("initial", null);
            // An uninitialized world has no workflow. A definite rejection is not a fabricated empty status.
            throws(() => world.status());
            equal(await readFile(join(root, "shim-argv.jsonl"), "utf8"), '["attached","status"]\n');
            const after = await world.snapshot("stale-adapter", null);
            equal(after.files, before.files);
            equal(await readFile(join(root, "sentinel-binaries.log"), "utf8"), "");
        } finally {
            await world.close();
        }
    });
});

test("Core model sentinels refuse invocation and record the command", async () => {
    await withExternalClaude(UNAUTHENTICATED_CLAUDE, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        try {
            for (const command of ["claude", "pi"])
                throws(() => execFileSync(join(root, "sentinels", command), ["--version"]));
            const rows = (await readFile(join(root, "sentinel-binaries.log"), "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
            equal(
                rows.map((row) => row.command),
                ["claude", "pi"],
            );
        } finally {
            await world.close();
        }
    });
});

test("changed validation instrumentation is rejected", async () => {
    await withExternalClaude(UNAUTHENTICATED_CLAUDE, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        try {
            await world.checkInstrumentation(world.fixture);
            await writeFile(join(world.fixture, "check.sh"), "exit 0\n");
            await rejects(world.checkInstrumentation(world.fixture), /instrumentation changed/);
        } finally {
            await world.close();
        }
    });
});

test("authentication preflight fails before any model or Core tool call", async () => {
    await withExternalClaude(UNAUTHENTICATED_CLAUDE, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        try {
            await rejects(
                world.prepare(),
                (error) => error instanceof PrerequisiteError && error.prerequisite === "claude-authentication",
            );
            equal(await readFile(join(root, "shim-argv.jsonl"), "utf8"), "");
            equal(await readdir(join(root, "logs/claude")), []);
        } finally {
            await world.close();
        }
    });
});

for (const assets of ["missing-server", "missing-client"])
    test(`browser preflight blocks ${assets} before any model or Core call`, async () => {
        const authenticated = UNAUTHENTICATED_CLAUDE.replace("loggedIn:false", "loggedIn:true").replace(
            "process.exitCode=1",
            "process.exitCode=0",
        );
        await withExternalClaude(authenticated, async (root, claude) => {
            const checkout = root + "-checkout";
            for (const path of [
                ".claude-plugin/marketplace.json",
                "src/attached/claude/plugin",
                "src/agent-definitions/shared-practice/review-practice.md",
            ]) {
                await mkdir(join(checkout, path, ".."), { recursive: true });
                await cp(join(CHECKOUT, path), join(checkout, path), { recursive: true });
            }
            if (assets === "missing-client") {
                await mkdir(join(checkout, "dist/workspace-bun/server"), { recursive: true });
                await writeFile(join(checkout, "dist/workspace-bun/server/entry.mjs"), "// server\n");
                await mkdir(join(checkout, "dist/workspace-bun/client/_astro"), { recursive: true });
            }
            const world = await AcceptanceWorld.create(root, checkout, claude);
            try {
                await rejects(
                    world.prepare(),
                    (error) => error instanceof PrerequisiteError && error.prerequisite === "workspace-assets",
                );
                equal(await readdir(join(root, "logs/claude")), []);
                equal(await readFile(join(root, "shim-argv.jsonl"), "utf8"), "");
            } finally {
                await world.close();
            }
        });
    });

test("private-file cleanup keeps the summary and unexpected user files", async () => {
    await withExternalClaude(UNAUTHENTICATED_CLAUDE, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        await world.close();
        await writeFile(join(root, "summary.json"), "{}");
        await writeFile(join(root, "keep-user-file"), "keep");
        await world.discardPrivateFiles();
        equal((await readdir(root)).sort(), ["keep-user-file", "summary.json"]);
    });
});

test("both real Reviewer modes receive the fixture-only layered practice rule", async () => {
    await withExternalClaude(UNAUTHENTICATED_CLAUDE, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        try {
            const loader = join(CHECKOUT, "src/shared/workflow/validation.ts");
            const code = `import {loadReviewerPrompt} from ${JSON.stringify(loader)};
                const prompts=await Promise.all(['discovery','verify'].map(mode=>loadReviewerPrompt(mode)));
                console.log(JSON.stringify(prompts.map(prompt=>prompt.systemPrompt.includes('acceptance-notes'))));`;
            const output = execFileSync(process.execPath, ["--no-env-file", "-e", code], {
                cwd: world.fixture,
                env: {
                    HOME: join(root, "runwield-home"),
                    PATH: process.env.PATH,
                    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
                },
                encoding: "utf8",
                timeout: 30_000,
            });
            equal(JSON.parse(output), [true, true]);
        } finally {
            await world.close();
        }
    });
});

test("carrier finds a real workflow in the Core home, not the Claude home", async () => {
    await withExternalClaude(UNAUTHENTICATED_CLAUDE, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        try {
            const coordinator = join(CHECKOUT, "src/shared/attached/coordinator.ts");
            const input = {
                operationId: "home-contract",
                evidence: {
                    host: "claude-code",
                    hostVersion: "2.1.303",
                    adapterVersion: "0.2.0",
                    adapterContract: 1,
                },
                payload: { requestText: "Add greeting", hostRequestId: "home-contract" },
            };
            const code = `import {runAttachedOperation} from ${JSON.stringify(coordinator)};
                const result=await runAttachedOperation('activate',${JSON.stringify(world.fixture)},${JSON.stringify(JSON.stringify(input))});
                if(!result.ok) throw Error(JSON.stringify(result)); console.log(result.workflow.workflowId);`;
            const workflowId = execFileSync(process.execPath, ["--no-env-file", "-e", code], {
                cwd: world.fixture,
                env: {
                    HOME: join(root, "runwield-home"),
                    PATH: process.env.PATH,
                    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
                },
                encoding: "utf8",
                timeout: 30_000,
            }).trim();
            const current = world.status();
            equal((current.workflow as { workflowId: string }).workflowId, workflowId);
        } finally {
            await world.close();
        }
    });
});

test("the fixture policy reaches the actual Core handoff and uses Core-assigned finding IDs", async () => {
    await withExternalClaude(UNAUTHENTICATED_CLAUDE, async (root, claude) => {
        const world = await AcceptanceWorld.create(root, CHECKOUT, claude);
        try {
            const code = `
                import {ok as assert} from 'node:assert/strict';
                import {writeFile} from 'node:fs/promises';
                import {join} from 'node:path';
                import {attachedValidationFixture} from ${JSON.stringify(join(CHECKOUT, "src/shared/attached/validation-test-fixture.ts"))};
                import {inspectSemantic} from ${JSON.stringify(join(CHECKOUT, "src/shared/attached/delivery-test-fixture.ts"))};
                const fixture=await attachedValidationFixture();
                try {
                    await writeFile(join(fixture.cwd,'marker'),'pass');
                    let result=await fixture.call('start_validation',await fixture.status());
                    assert(result.ok && result.instructions.text.includes('Omit id for a new finding; Core assigns its stable ledger ID.'));
                    let inspected=await inspectSemantic(fixture,result.workflow);
                    const finding={title:'acceptance-notes',status:'new',requirement:'Require NOTES.md acceptance line',evidence:'NOTES.md is absent'};
                    result=await fixture.call('review_complete',inspected.workflow,{actionId:inspected.actionId,approved:false,findings:[{...finding,id:'acceptance-notes'}]});
                    assert(result.ok && result.workflow.nextAction.request.kind==='reviewer');
                    assert(result.instructions.text.includes('acceptance-notes'));
                    inspected=await inspectSemantic(fixture,result.workflow);
                    result=await fixture.call('review_complete',inspected.workflow,{actionId:inspected.actionId,approved:false,findings:[finding]});
                    assert(result.ok && result.workflow.nextAction.request.kind==='repair');
                    const assigned=result.workflow.nextAction.request.prompt.match(/\\bR\\d+-\\d+\\b/);
                    assert(assigned);
                    await writeFile(join(fixture.cwd,'NOTES.md'),'acceptance: reviewed\\n');
                    result=await fixture.call('task_completed',result.workflow,{actionId:result.workflow.nextAction.actionId,message:'- Fixed '+assigned[0]+': added required line.'});
                    assert(result.ok && result.instructions.text.includes('acceptance-notes'));
                    inspected=await inspectSemantic(fixture,result.workflow);
                    result=await fixture.call('review_complete',inspected.workflow,{actionId:inspected.actionId,approved:true,findings:[{id:assigned[0],title:'acceptance-notes',status:'fix_confirmed'}]});
                    assert(result.ok && result.workflow.nextAction.kind==='code_review');
                    console.log(JSON.stringify({codeReview:true,ciRuns:await fixture.ciCount(),planStatus:(await fixture.plan()).attrs.status}));
                } finally {await fixture.close();}
            `;
            const output = execFileSync(process.execPath, ["--no-env-file", "-e", code], {
                cwd: world.fixture,
                env: {
                    HOME: join(root, "runwield-home"),
                    PATH: process.env.PATH,
                    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
                },
                encoding: "utf8",
                timeout: 30_000,
            });
            equal(JSON.parse(output), { codeReview: true, ciRuns: 2, planStatus: "reviewed" });
        } finally {
            await world.close();
        }
    });
});
