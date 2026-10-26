import { getCwd } from "../../constants.js";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
    chmod as fsChmod,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    realpath as fsRealpath,
    rename as fsRename,
    rm as fsRm,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import process from "node:process";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "../../testing/assertions.ts";
import { dirname, join } from "node:path";
import {
    hashPlanBody,
    injectFrontMatter,
    loadPlan,
    savePlan,
    updatePlanCollaborationMetadata,
} from "../../plan-store.js";
import { defineCommittedGitFixture, git } from "../../shared/git-test-fixture.ts";
import { PlanningNotStartedError } from "../../shared/workflow/plan-location.ts";
import { listEntries } from "../../shared/worktree-registry.js";
import { resolveProjectRuntimeLayout } from "../../shared/project-runtime-layout.ts";
import { generateBearerCapability, hashCapability, MAINTAINER_SCOPE } from "../../shared/collaboration/capabilities.ts";
import { createCollaborationClient, SYSTEM_COLLABORATION_FETCH } from "../../shared/collaboration/client.js";
import { encryptJsonPayload, generateContentKeyString, importContentKey } from "../../shared/collaboration/crypto.ts";
import { COLLABORATION_LOCK_BYPASS } from "../../shared/collaboration/lock.ts";
import {
    getGlobalSecretStoreLocation,
    getGlobalSecretStorePath,
    getProjectSecretStoreLocation,
    getProjectSecretStorePath,
    readSecretStore,
} from "../../shared/collaboration/secrets.js";
import { parseCollaborationUrl } from "../../shared/collaboration/urls.ts";
import { createSessionRuntime } from "../../shared/session/session-runtime.ts";
import { withRuntimeCommandFixture } from "../testing/runtime-command-fixture.ts";
import { withCollaborationServer } from "./collaboration-command-test-fixture.ts";
import { parsePlansPullArgs, pullPlanForRevision, runPlansPullCommand } from "./pull.ts";
import { parsePlansPushArgs, pushPlanRevision, runPlansPushCommand } from "./push.ts";
import { parsePlansShareArgs, runPlansShareCommand, sharePlanForReview } from "./share.ts";
import { parsePlansUnshareArgs, runPlansUnshareCommand, unsharePlan } from "./unshare.ts";

interface CapturedConsole {
    errors: string[];
    logs: string[];
}

async function captureConsole(run: () => Promise<void>): Promise<CapturedConsole> {
    const originalError = console.error;
    const originalLog = console.log;
    const errors: string[] = [];
    const logs: string[] = [];
    console.error = (message = "") => errors.push(String(message));
    console.log = (message = "") => logs.push(String(message));
    try {
        await run();
    } finally {
        console.error = originalError;
        console.log = originalLog;
    }
    return { errors, logs };
}

async function seedPlan(projectRoot: string, name = "demo-plan"): Promise<void> {
    await savePlan(projectRoot, name, "# Demo Plan\n\nInitial fixture body.\n", {
        classification: "PLANNED_CHANGE",
        complexity: "LOW",
        status: "approved",
        summary: "Demo collaboration Plan",
        affectedPaths: ["src/demo.ts"],
    });
}

function findRoleUrl(logs: string[], role: "maintainer" | "reviewer"): string {
    const url = logs.find((line) => line.startsWith("http") && line.includes(`role=${role}`));
    if (!url) throw new Error(`Missing ${role} collaboration URL in command output.`);
    return url;
}

async function createLinkedCheckout(projectRoot: string, linkedRoot: string): Promise<void> {
    await git(projectRoot, ["init", "-b", "main"]);
    await git(projectRoot, ["config", "user.email", "fixture@runwield.test"]);
    await git(projectRoot, ["config", "user.name", "RunWield Fixture"]);
    await git(projectRoot, ["config", "commit.gpgsign", "false"]);
    await fsRm(join(projectRoot, ".wld", "internal"), { recursive: true }).catch(() => {});
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "-m", "collaboration fixture"]);
    const previousCwd = getCwd();
    process.chdir(projectRoot);
    try {
        await fsRm(linkedRoot, { recursive: true });
        await git(projectRoot, ["worktree", "add", "-b", `linked-${crypto.randomUUID()}`, linkedRoot]);
    } finally {
        process.chdir(previousCwd);
    }
}

test("Plan collaboration argument parsers accept their public command forms", () => {
    assertEquals(parsePlansShareArgs(["demo", "--plan-server", "https://plans.example", "--project-secrets"]), {
        planServer: "https://plans.example",
        projectSecrets: true,
        help: false,
        target: "demo",
    });
    assertEquals(parsePlansPullArgs(["https://plans.example/p/space#key=k&cap=c&role=maintainer", "--to", "copy"]), {
        target: "https://plans.example/p/space#key=k&cap=c&role=maintainer",
        planServer: undefined,
        projectSecrets: false,
        to: "copy",
        help: false,
    });
    assertEquals(parsePlansPushArgs(["demo", "--project-secrets"]).projectSecrets, true);
    assertEquals(parsePlansUnshareArgs(["demo", "--force"]).force, true);
    assertThrows(() => parsePlansShareArgs([]), Error, "Missing Plan");
    assertThrows(() => parsePlansPullArgs(["one", "two"]), Error, "Unexpected pull argument");
    assertThrows(() => parsePlansPushArgs([]), Error, "Missing Plan");
    assertThrows(() => parsePlansUnshareArgs([]), Error, "Missing Plan");
});

test("share, push, pull, and unshare compose through real Plan, crypto, secret, runtime, and HTTP machinery", async () => {
    await withRuntimeCommandFixture(
        "runwield-plan-collaboration-",
        async ({ alternateRoot, projectRoot, setModelResponse }) => {
            await withCollaborationServer(async ({ adapter, serverUrl }) => {
                await seedPlan(projectRoot);
                setModelResponse("I reviewed the pulled fixture Plan and prepared the requested planning revision.");

                process.chdir(projectRoot);
                const sharedOutput = await captureConsole(() =>
                    runPlansShareCommand(["demo-plan", "--plan-server", serverUrl]),
                );
                const reviewerUrl = findRoleUrl(sharedOutput.logs, "reviewer");
                const maintainerUrl = findRoleUrl(sharedOutput.logs, "maintainer");
                const reviewer = parseCollaborationUrl(reviewerUrl);
                const maintainer = parseCollaborationUrl(maintainerUrl);
                assertEquals(reviewer.spaceId, maintainer.spaceId);

                const sharedPlan = await loadPlan(projectRoot, "demo-plan");
                assert(sharedPlan);
                assertEquals(sharedPlan.attrs.collaborationState, "remote_canonical");
                assertEquals(sharedPlan.attrs.collaborationServerUrl, serverUrl);
                assertEquals(sharedPlan.attrs.collaborationRevision, 1);
                assertEquals(sharedPlan.body, "# Demo Plan\n\nInitial fixture body.\n");
                assertEquals(sharedPlan.markdown.includes(reviewer.contentKey), false);
                assertEquals(sharedPlan.markdown.includes(maintainer.bearerCapability), false);

                const globalSecrets = await readSecretStore(getGlobalSecretStoreLocation());
                const storedSecret = globalSecrets.records[`${sharedPlan.attrs.planId}:${reviewer.spaceId}`];
                assert(storedSecret);
                assertEquals(storedSecret.contentKey, reviewer.contentKey);
                assertEquals(storedSecret.reviewerCapability, reviewer.bearerCapability);
                assertEquals(storedSecret.maintainerCapability, maintainer.bearerCapability);

                const storedRemoteText = JSON.stringify(
                    adapter.database.handle
                        .prepare(
                            "SELECT payload_ciphertext, capability_hash FROM space_revisions CROSS JOIN space_capabilities",
                        )
                        .all(),
                );
                assertEquals(storedRemoteText.includes("Initial fixture body"), false);
                assertEquals(storedRemoteText.includes(reviewer.bearerCapability), false);
                assertEquals(storedRemoteText.includes(maintainer.bearerCapability), false);

                const pushedBody = "# Demo Plan\n\nBody edited in the fixture checkout before push.\n";
                await fsWriteFile(sharedPlan.path, injectFrontMatter(pushedBody, sharedPlan.attrs));
                const pushedOutput = await captureConsole(() => runPlansPushCommand(["demo-plan"]));
                assertStringIncludes(pushedOutput.logs.join("\n"), "revision 2");
                assertStringIncludes(pushedOutput.logs.join("\n"), "role=reviewer");
                assertEquals(pushedOutput.logs.join("\n").includes(maintainer.bearerCapability), false);
                assertEquals((await loadPlan(projectRoot, "demo-plan"))?.attrs.collaborationRevision, 2);

                const reviewerClient = createCollaborationClient({
                    serverUrl,
                    bearerCapability: reviewer.bearerCapability,
                    fetch: SYSTEM_COLLABORATION_FETCH,
                });
                const commentKey = await importContentKey(reviewer.contentKey);
                const commentCiphertext = await encryptJsonPayload(
                    {
                        schemaVersion: 1,
                        type: "global_comment",
                        displayName: "Fixture Reviewer",
                        body: "Please preserve the fixture behavior.",
                        createdAt: "2026-08-03T12:00:00.000Z",
                    },
                    commentKey,
                );
                await reviewerClient.appendComment(reviewer.spaceId, 2, { ciphertext: commentCiphertext });

                process.chdir(alternateRoot);
                const runtime = createSessionRuntime();
                try {
                    const sessionId = await runtime.createPromptReadySession({
                        cwd: alternateRoot,
                        agentName: "router",
                    });
                    const pulledOutput = await captureConsole(() =>
                        runPlansPullCommand([maintainerUrl, "--to", "pulled-demo"], {
                            sessionRuntime: runtime,
                            sessionId,
                        }),
                    );
                    assertStringIncludes(pulledOutput.logs.join("\n"), "revision 2");
                    assertStringIncludes(pulledOutput.logs.join("\n"), "Decrypted 1 comments (0 unreadable)");
                    assertStringIncludes(pulledOutput.logs.join("\n"), "Selected planning Agent");
                } finally {
                    runtime.closeAllSessions();
                }

                const pulledPlan = await loadPlan(alternateRoot, "pulled-demo");
                assert(pulledPlan);
                assertEquals(pulledPlan.body.trimEnd(), pushedBody.trimEnd());
                assertEquals(pulledPlan.attrs.planId, sharedPlan.attrs.planId);
                assertEquals(pulledPlan.attrs.collaborationRevision, 2);

                const unsharedOutput = await captureConsole(() => runPlansUnshareCommand(["pulled-demo", "--force"]));
                assertStringIncludes(unsharedOutput.logs.join("\n"), "Cleared local collaboration lock metadata");
                const unsharedPlan = await loadPlan(alternateRoot, "pulled-demo");
                assert(unsharedPlan);
                assertEquals(unsharedPlan.body.trimEnd(), pushedBody.trimEnd());
                assertEquals(unsharedPlan.attrs.collaborationState, undefined);
                assertEquals(Object.keys((await readSecretStore(getGlobalSecretStoreLocation())).records).length, 0);

                const deletedClient = createCollaborationClient({
                    serverUrl,
                    bearerCapability: maintainer.bearerCapability,
                    fetch: SYSTEM_COLLABORATION_FETCH,
                });
                await assertRejects(
                    () => deletedClient.getSharedSpace(maintainer.spaceId),
                    Error,
                    "Plan Server error 404",
                );
            });
        },
    );
});

test("named pull and push use a linked checkout's migrated 0.10 capability", async () => {
    await withRuntimeCommandFixture(
        "runwield-plan-collaboration-migrated-capability-",
        async ({ alternateRoot, projectRoot, setModelResponse }) => {
            const originalSandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
            try {
                delete process.env["WLD_TEST_SANDBOX_HOME"];
                await withCollaborationServer(async ({ adapter, serverUrl }) => {
                    const planName = "migrated-capability";
                    const planId = crypto.randomUUID();
                    const body = "# Migrated capability\n\nContent encrypted before runtime migration.\n";
                    const contentKey = await generateContentKeyString();
                    const maintainerCapability = generateBearerCapability();
                    await savePlan(projectRoot, planName, body, {
                        planId,
                        classification: "PLANNED_CHANGE",
                        complexity: "LOW",
                        status: "approved",
                        summary: "Migrated capability",
                    });
                    await createLinkedCheckout(projectRoot, alternateRoot);
                    const existingPlan = await loadPlan(alternateRoot, planName);
                    assert(existingPlan);
                    const storedBody = existingPlan.body;
                    const payloadCiphertext = await encryptJsonPayload(
                        {
                            planId,
                            title: "Migrated capability",
                            metadata: {
                                classification: "PLANNED_CHANGE",
                                complexity: "LOW",
                                status: "approved",
                                summary: "Migrated capability",
                            },
                            body: storedBody,
                        },
                        await importContentKey(contentKey),
                    );
                    const created = adapter.createSharedSpace({
                        planId,
                        payloadCiphertext,
                        capabilities: [
                            {
                                scope: MAINTAINER_SCOPE,
                                capabilityHash: await hashCapability(maintainerCapability),
                            },
                        ],
                    });
                    await updatePlanCollaborationMetadata(
                        alternateRoot,
                        planName,
                        {
                            collaborationState: "remote_canonical",
                            collaborationServerUrl: serverUrl,
                            collaborationSpaceId: created.spaceId,
                            collaborationRevision: 1,
                            collaborationBodyHash: await hashPlanBody(storedBody),
                        },
                        COLLABORATION_LOCK_BYPASS.share,
                        { body: storedBody },
                    );
                    assertEquals((await loadPlan(alternateRoot, planName))?.body, storedBody);
                    const remoteBody = "# Migrated capability\n\nRemote content encrypted before runtime migration.\n";
                    adapter.appendRevision(
                        created.spaceId,
                        await encryptJsonPayload(
                            {
                                planId,
                                title: "Migrated capability",
                                metadata: {
                                    classification: "PLANNED_CHANGE",
                                    complexity: "LOW",
                                    status: "approved",
                                    summary: "Migrated capability",
                                },
                                body: remoteBody,
                            },
                            await importContentKey(contentKey),
                        ),
                        2,
                    );
                    await fsRename(
                        join(projectRoot, ".wld", "internal", "controller"),
                        join(projectRoot, ".wld", "controller"),
                    );
                    await fsRm(join(projectRoot, ".wld", "internal"), { recursive: true });
                    await fsRm(join(alternateRoot, ".wld", "internal"), { recursive: true }).catch(() => {});

                    const recordKey = `${planId}:${created.spaceId}`;
                    const legacyStorePath = join(alternateRoot, ".wld", "collaboration-secrets.json");
                    const legacyStoreBytes = `${JSON.stringify(
                        {
                            schemaVersion: 1,
                            records: {
                                [recordKey]: {
                                    planId,
                                    spaceId: created.spaceId,
                                    contentKey,
                                    maintainerCapability,
                                    updatedAt: "2026-01-01T00:00:00.000Z",
                                },
                            },
                        },
                        null,
                        2,
                    )}\n`;
                    await fsMkdir(dirname(legacyStorePath), { recursive: true });
                    await fsWriteFile(legacyStorePath, legacyStoreBytes, { mode: 0o600 });
                    await fsChmod(legacyStorePath, 0o600).catch(() => {});
                    assertEquals(Object.keys((await readSecretStore(getGlobalSecretStoreLocation())).records), []);

                    process.chdir(alternateRoot);
                    setModelResponse("The migrated collaboration content remains valid.");
                    const runtime = createSessionRuntime();
                    try {
                        const sessionId = await runtime.createPromptReadySession({
                            cwd: alternateRoot,
                            agentName: "router",
                        });
                        const migratedStore = await readSecretStore(await getProjectSecretStoreLocation(alternateRoot));
                        assertEquals(Object.keys(migratedStore.records), [recordKey]);
                        assertEquals((await loadPlan(alternateRoot, planName))?.body, storedBody);
                        const pulledOutput = await captureConsole(() =>
                            runPlansPullCommand([planName, "--project-secrets"], {
                                sessionRuntime: runtime,
                                sessionId,
                            }),
                        );
                        assertStringIncludes(pulledOutput.logs.join("\n"), "revision 2");
                    } finally {
                        runtime.closeAllSessions();
                    }
                    assertEquals((await loadPlan(alternateRoot, planName))?.body, remoteBody);

                    const primaryStorePath = resolveProjectRuntimeLayout(alternateRoot).primary.projectSecretStorePath;
                    assertEquals(await fsReadFile(primaryStorePath, "utf8"), legacyStoreBytes);
                    if (process.platform !== "win32") {
                        assertEquals(((await fsStat(primaryStorePath)).mode ?? 0) & 0o777, 0o600);
                    }
                    await assertRejects(() => fsStat(legacyStorePath));
                    assertEquals(Object.keys((await readSecretStore(getGlobalSecretStoreLocation())).records), []);

                    const pushedBody = "# Migrated capability\n\nChanged after migration.\n";
                    const pulledPlan = await loadPlan(alternateRoot, planName);
                    assert(pulledPlan);
                    await fsWriteFile(pulledPlan.path, injectFrontMatter(pushedBody, pulledPlan.attrs));
                    const pushedOutput = await captureConsole(() =>
                        runPlansPushCommand([planName, "--project-secrets"]),
                    );
                    assertStringIncludes(pushedOutput.logs.join("\n"), "revision 3");
                    assertEquals(adapter.getSharedSpace(created.spaceId).latestRevision, 3);
                    assertEquals(
                        adapter.database.handle
                            .prepare("SELECT capability_hash FROM space_capabilities WHERE space_id = ? AND scope = ?")
                            .get(created.spaceId, MAINTAINER_SCOPE)?.capability_hash,
                        await hashCapability(maintainerCapability),
                    );
                    assertEquals(await fsReadFile(primaryStorePath, "utf8"), legacyStoreBytes);

                    await fsWriteFile(primaryStorePath, `${JSON.stringify({ schemaVersion: 1, records: {} })}\n`, {
                        mode: 0o600,
                    });
                    await assertRejects(
                        () => captureConsole(() => runPlansPullCommand([planName, "--project-secrets"])),
                        Error,
                        "maintainer secrets are missing",
                    );
                });
            } finally {
                if (originalSandboxHome === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
                else process.env["WLD_TEST_SANDBOX_HOME"] = originalSandboxHome;
            }
        },
    );
});

test("project-local collaboration commands share one primary store across linked checkouts", async () => {
    await withRuntimeCommandFixture(
        "runwield-plan-collaboration-project-secrets-",
        async ({ alternateRoot, projectRoot }) => {
            const originalSandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
            try {
                delete process.env["WLD_TEST_SANDBOX_HOME"];
                await seedPlan(projectRoot, "project-secret-plan");
                await createLinkedCheckout(projectRoot, alternateRoot);
                const legacyRecord = {
                    planId: "legacy-plan",
                    spaceId: "legacy-space",
                    contentKey: "legacy-content-key",
                    maintainerCapability: "legacy-capability",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                };
                await fsMkdir(join(alternateRoot, ".wld"), { recursive: true });
                await fsWriteFile(
                    join(alternateRoot, ".wld", "collaboration-secrets.json"),
                    `${JSON.stringify({ schemaVersion: 1, records: { "legacy-plan:legacy-space": legacyRecord } })}\n`,
                );
                const globalPath = getGlobalSecretStorePath();
                await fsMkdir(dirname(globalPath), { recursive: true });
                const globalBefore = `${JSON.stringify(
                    {
                        schemaVersion: 1,
                        records: {
                            "global-plan:global-space": {
                                planId: "global-plan",
                                spaceId: "global-space",
                                contentKey: "global-key",
                                updatedAt: "2026-01-01T00:00:00.000Z",
                            },
                        },
                    },
                    null,
                    2,
                )}\n`;
                await fsWriteFile(globalPath, globalBefore);

                await withCollaborationServer(async ({ serverUrl }) => {
                    const shared = await sharePlanForReview({
                        target: "project-secret-plan",
                        cwd: alternateRoot,
                        planServer: serverUrl,
                        projectSecrets: true,
                    });
                    const maintainer = parseCollaborationUrl(shared.maintainerUrl);
                    const primaryStorePath = join(projectRoot, ".wld", "internal", "collaboration-secrets.json");
                    assertEquals(getProjectSecretStorePath(alternateRoot), primaryStorePath);
                    const projectStore = await readSecretStore(await getProjectSecretStoreLocation(alternateRoot));
                    const recordKey = `${shared.planId}:${shared.spaceId}`;
                    assertEquals(projectStore.records[recordKey].contentKey, maintainer.contentKey);
                    assertEquals(projectStore.records["legacy-plan:legacy-space"], legacyRecord);
                    assertEquals(projectStore.records["global-plan:global-space"], undefined);
                    assertStringIncludes(await fsReadFile(join(projectRoot, ".gitignore"), "utf8"), ".wld/internal");
                    await assertRejects(() => fsStat(join(alternateRoot, ".wld", "collaboration-secrets.json")));
                    await assertRejects(() => fsStat(join(projectRoot, ".wld", "collaboration-secrets.json")));
                    await assertRejects(() =>
                        fsStat(join(alternateRoot, ".wld", "internal", "collaboration-secrets.json")),
                    );
                    assertEquals(await fsReadFile(globalPath, "utf8"), globalBefore);

                    const sharedPlan = await loadPlan(alternateRoot, "project-secret-plan");
                    assert(sharedPlan);
                    const primaryPlan = await loadPlan(projectRoot, "project-secret-plan");
                    assert(primaryPlan);
                    await fsWriteFile(primaryPlan.path, sharedPlan.markdown);
                    const pushedBody = "# Demo Plan\n\nEdited in primary checkout.\n";
                    await fsWriteFile(primaryPlan.path, injectFrontMatter(pushedBody, sharedPlan.attrs));
                    const pushed = await pushPlanRevision({
                        target: "project-secret-plan",
                        cwd: projectRoot,
                        projectSecrets: true,
                    });
                    assertEquals(pushed.revision, 2);

                    const primaryAfterPush = await loadPlan(projectRoot, "project-secret-plan");
                    assert(primaryAfterPush);
                    await updatePlanCollaborationMetadata(
                        alternateRoot,
                        "project-secret-plan",
                        { ...primaryAfterPush.attrs, collaborationRevision: 1 },
                        COLLABORATION_LOCK_BYPASS.pull,
                        { body: primaryAfterPush.body },
                    );
                    const pulledByName = await pullPlanForRevision({
                        target: "project-secret-plan",
                        cwd: alternateRoot,
                        projectSecrets: true,
                    });
                    assertEquals(pulledByName.revision, 2);
                    const linkedPulledPlan = await loadPlan(alternateRoot, "project-secret-plan");
                    assert(linkedPulledPlan);
                    assertEquals(linkedPulledPlan.body.trimEnd(), pushedBody.trimEnd());
                    assertEquals(linkedPulledPlan.attrs.collaborationRevision, 2);

                    await fsWriteFile(
                        primaryStorePath,
                        `${JSON.stringify(
                            {
                                schemaVersion: 1,
                                records: {
                                    ...projectStore.records,
                                    "other-plan:other-space": {
                                        ...projectStore.records[recordKey],
                                        planId: "other-plan",
                                        spaceId: "other-space",
                                    },
                                },
                            },
                            null,
                            2,
                        )}\n`,
                    );
                    const result = await unsharePlan({
                        target: "project-secret-plan",
                        cwd: projectRoot,
                        projectSecrets: true,
                        force: true,
                    });
                    assertEquals(result.deletedSecretCount, 1);
                    const afterUnshare = await readSecretStore(await getProjectSecretStoreLocation(projectRoot));
                    assertEquals(afterUnshare.records[recordKey], undefined);
                    assertEquals(afterUnshare.records["other-plan:other-space"]?.planId, "other-plan");
                    assertEquals(await fsReadFile(globalPath, "utf8"), globalBefore);
                });
            } finally {
                if (originalSandboxHome === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
                else process.env["WLD_TEST_SANDBOX_HOME"] = originalSandboxHome;
            }
        },
    );
});

test("project maintainer URL import writes only the fresh primary store and keeps the Plan selected-local", async () => {
    await withRuntimeCommandFixture("runwield-plan-collaboration-project-url-", async ({ projectRoot }) => {
        const originalSandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
        const freshPrimary = await fsMkdtemp(join(tmpdir(), "runwield-url-import-primary-"));
        const freshLinked = await fsMkdtemp(join(tmpdir(), "runwield-url-import-linked-"));
        try {
            delete process.env["WLD_TEST_SANDBOX_HOME"];
            await seedPlan(projectRoot, "source-url-plan");
            await withCollaborationServer(async ({ serverUrl }) => {
                const shared = await sharePlanForReview({
                    target: "source-url-plan",
                    cwd: projectRoot,
                    planServer: serverUrl,
                    projectSecrets: true,
                });
                await fsWriteFile(join(freshPrimary, "README.md"), "# Fresh project\n");
                await createLinkedCheckout(freshPrimary, freshLinked);

                const pulled = await pullPlanForRevision({
                    target: shared.maintainerUrl,
                    cwd: freshLinked,
                    projectSecrets: true,
                    to: "imported-url-plan",
                });

                const importedPlan = await loadPlan(freshLinked, "imported-url-plan");
                assert(importedPlan);
                assertEquals(importedPlan.path?.startsWith(freshLinked), true);
                assertEquals(pulled.secretImported, true);
                const freshStorePath = join(
                    await fsRealpath(freshPrimary),
                    ".wld",
                    "internal",
                    "collaboration-secrets.json",
                );
                assertEquals(getProjectSecretStorePath(freshLinked), freshStorePath);
                const maintainer = parseCollaborationUrl(shared.maintainerUrl);
                assertEquals(
                    (await readSecretStore(await getProjectSecretStoreLocation(freshLinked))).records[
                        `${shared.planId}:${shared.spaceId}`
                    ].maintainerCapability,
                    maintainer.bearerCapability,
                );
                assertEquals(Object.keys((await readSecretStore(getGlobalSecretStoreLocation())).records).length, 0);
                await assertRejects(() => fsStat(join(freshLinked, ".wld", "collaboration-secrets.json")));
                await assertRejects(() => fsStat(join(freshLinked, ".wld", "internal", "collaboration-secrets.json")));
            });
        } finally {
            if (originalSandboxHome === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
            else process.env["WLD_TEST_SANDBOX_HOME"] = originalSandboxHome;
            await fsRm(freshLinked, { recursive: true }).catch(() => {});
            await fsRm(freshPrimary, { recursive: true }).catch(() => {});
        }
    });
});

test("project share does not write local secrets when primary ignore protection fails", async () => {
    await withRuntimeCommandFixture(
        "runwield-plan-collaboration-ignore-failure-",
        async ({ alternateRoot, projectRoot }) => {
            const originalSandboxHome = process.env["WLD_TEST_SANDBOX_HOME"];
            try {
                delete process.env["WLD_TEST_SANDBOX_HOME"];
                await seedPlan(projectRoot, "ignore-failure-plan");
                await createLinkedCheckout(projectRoot, alternateRoot);
                await fsRm(join(projectRoot, ".gitignore")).catch(() => {});
                await fsMkdir(join(projectRoot, ".gitignore"));
                await withCollaborationServer(async ({ serverUrl }) => {
                    await assertRejects(() =>
                        sharePlanForReview({
                            target: "ignore-failure-plan",
                            cwd: alternateRoot,
                            planServer: serverUrl,
                            projectSecrets: true,
                        }),
                    );
                    await assertRejects(() =>
                        fsStat(resolveProjectRuntimeLayout(alternateRoot).primary.projectSecretStorePath),
                    );
                });
            } finally {
                if (originalSandboxHome === undefined) delete process.env["WLD_TEST_SANDBOX_HOME"];
                else process.env["WLD_TEST_SANDBOX_HOME"] = originalSandboxHome;
            }
        },
    );
});

test("real collaboration guards reject unsafe operations without replacing their machinery", async () => {
    await withRuntimeCommandFixture("runwield-plan-collaboration-guards-", async ({ alternateRoot, projectRoot }) => {
        await withCollaborationServer(async ({ serverUrl }) => {
            await seedPlan(projectRoot, "guarded");
            const shared = await sharePlanForReview({ target: "guarded", cwd: projectRoot, planServer: serverUrl });

            await assertRejects(
                () => pushPlanRevision({ target: "guarded", cwd: projectRoot }),
                Error,
                "duplicate no-op revision",
            );
            await assertRejects(
                () => pullPlanForRevision({ target: shared.reviewerUrl, cwd: alternateRoot }),
                Error,
                "requires a maintainer URL",
            );
            await assertRejects(
                () =>
                    unsharePlan({
                        target: "guarded",
                        cwd: projectRoot,
                        planServer: "https://other.example",
                        force: true,
                    }),
                Error,
                "does not match",
            );

            await unsharePlan({ target: "guarded", cwd: projectRoot, force: true });
            await savePlan(projectRoot, "archived/old", "# Archived fixture", { status: "verified" });
            await assertRejects(
                () => sharePlanForReview({ target: "archived/old", cwd: projectRoot, planServer: serverUrl }),
                Error,
                "Cannot share archived Plans",
            );
        });
    });
});

test("push observes real remote revision and lifecycle conflicts", async () => {
    await withRuntimeCommandFixture("runwield-plan-collaboration-remote-guards-", async ({ projectRoot }) => {
        await withCollaborationServer(async ({ serverUrl }) => {
            await seedPlan(projectRoot, "stale-remote");
            await seedPlan(projectRoot, "closed-remote");
            const stale = await sharePlanForReview({ target: "stale-remote", cwd: projectRoot, planServer: serverUrl });
            const closed = await sharePlanForReview({
                target: "closed-remote",
                cwd: projectRoot,
                planServer: serverUrl,
            });
            const staleMaintainer = parseCollaborationUrl(stale.maintainerUrl);
            const closedMaintainer = parseCollaborationUrl(closed.maintainerUrl);
            const staleClient = createCollaborationClient({
                serverUrl,
                bearerCapability: staleMaintainer.bearerCapability,
                fetch: SYSTEM_COLLABORATION_FETCH,
            });
            const closedClient = createCollaborationClient({
                serverUrl,
                bearerCapability: closedMaintainer.bearerCapability,
                fetch: SYSTEM_COLLABORATION_FETCH,
            });
            await staleClient.appendRevision(stale.spaceId, {
                payloadCiphertext: "opaque-fixture-revision",
                expectedRevision: 2,
            });
            await closedClient.updateSharedSpaceLifecycle(closed.spaceId, { action: "close" });

            await assertRejects(
                () => pushPlanRevision({ target: "stale-remote", cwd: projectRoot }),
                Error,
                "Run `wld plans pull` before pushing",
            );
            await assertRejects(() => pushPlanRevision({ target: "closed-remote", cwd: projectRoot }), Error, "closed");

            await unsharePlan({ target: "stale-remote", cwd: projectRoot, force: true });
            await unsharePlan({ target: "closed-remote", cwd: projectRoot, force: true });
        });
    });
});

test("declining the real unshare prompt preserves remote and local state", async () => {
    await withRuntimeCommandFixture("runwield-plan-collaboration-confirm-", async ({ projectRoot }) => {
        await withCollaborationServer(async ({ serverUrl }) => {
            await seedPlan(projectRoot, "keep-shared");
            const shared = await sharePlanForReview({ target: "keep-shared", cwd: projectRoot, planServer: serverUrl });
            const maintainer = parseCollaborationUrl(shared.maintainerUrl);
            const client = createCollaborationClient({
                serverUrl,
                bearerCapability: maintainer.bearerCapability,
                fetch: SYSTEM_COLLABORATION_FETCH,
            });
            const previousPrompt = globalThis.prompt;
            globalThis.prompt = () => "no";
            try {
                await assertRejects(
                    () => unsharePlan({ target: "keep-shared", cwd: projectRoot }),
                    Error,
                    "Unshare cancelled",
                );
            } finally {
                globalThis.prompt = previousPrompt;
            }

            await client.getSharedSpace(shared.spaceId);
            assertEquals((await loadPlan(projectRoot, "keep-shared"))?.attrs.collaborationState, "remote_canonical");
            assert(Object.keys((await readSecretStore(getGlobalSecretStoreLocation())).records).length > 0);
            await unsharePlan({ target: "keep-shared", cwd: projectRoot, force: true });
        });
    });
});

test("unshare recovers real local state when the remote Space is already deleted", async () => {
    await withRuntimeCommandFixture("runwield-plan-collaboration-deleted-", async ({ projectRoot }) => {
        await withCollaborationServer(async ({ serverUrl }) => {
            await seedPlan(projectRoot, "deleted-remote");
            const shared = await sharePlanForReview({
                target: "deleted-remote",
                cwd: projectRoot,
                planServer: serverUrl,
            });
            const maintainer = parseCollaborationUrl(shared.maintainerUrl);
            const client = createCollaborationClient({
                serverUrl,
                bearerCapability: maintainer.bearerCapability,
                fetch: SYSTEM_COLLABORATION_FETCH,
            });
            await client.deleteSharedSpace(shared.spaceId);

            const result = await unsharePlan({ target: "deleted-remote", cwd: projectRoot, force: true });
            assertEquals(result.alreadyDeleted, true);
            assertEquals(result.localMetadataCleared, true);
            assertEquals((await loadPlan(projectRoot, "deleted-remote"))?.attrs.collaborationState, undefined);
            assertEquals(Object.keys((await readSecretStore(getGlobalSecretStoreLocation())).records).length, 0);
        });
    });
});

const unstartedSharedFixture = defineCommittedGitFixture({ ".gitignore": ".wld/internal/\n" });

test("unstarted shared child refuses push and unshare before changing remote revisions or secrets", async () => {
    await withRuntimeCommandFixture("unstarted-shared-child-", async () => {
        await withCollaborationServer(async ({ serverUrl }) => {
            const repo = await unstartedSharedFixture.checkout();
            await seedPlan(repo, "epic/child");
            const shared = await sharePlanForReview({ cwd: repo, target: "epic/child", planServer: serverUrl });
            const plan = await loadPlan(repo, "epic/child");
            assert(plan);
            await savePlan(repo, "epic", "# Epic\n", {
                planId: "epic-id",
                classification: "PROJECT",
                status: "ready_for_work",
                targetBranch: "epic-target",
            });
            await fsWriteFile(
                plan.path,
                injectFrontMatter(plan.body, {
                    ...plan.attrs,
                    parentPlan: "epic",
                    targetBranch: "epic-target",
                }),
            );
            await git(repo, ["add", "."]);
            await git(repo, ["commit", "-m", "shared child on Epic branch"]);
            await git(repo, ["branch", "epic-target"]);
            await fsWriteFile(
                plan.path,
                (await fsReadFile(plan.path, "utf8")).replace("Initial fixture body.", "Updated fixture body."),
            );
            const before = await fsReadFile(plan.path, "utf8");
            const secrets = await readSecretStore(getGlobalSecretStoreLocation());
            const maintainer = parseCollaborationUrl(shared.maintainerUrl);
            const client = createCollaborationClient({
                serverUrl,
                bearerCapability: maintainer.bearerCapability,
                fetch: SYSTEM_COLLABORATION_FETCH,
            });
            const remote = await client.getSharedSpace(shared.spaceId);
            await assertRejects(() => pushPlanRevision({ cwd: repo, target: "epic/child" }), PlanningNotStartedError);
            await assertRejects(
                () => unsharePlan({ cwd: repo, target: "epic/child", force: true }),
                PlanningNotStartedError,
            );
            assertEquals(await client.getSharedSpace(shared.spaceId), remote);
            assertEquals(await readSecretStore(getGlobalSecretStoreLocation()), secrets);
            assertEquals(await fsReadFile(plan.path, "utf8"), before);
            assertEquals(await listEntries(repo), []);
        });
    });
});
