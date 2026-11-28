import { openWorkflow } from "@runwield/workflow";
import type { ReviseProjectPlan } from "@runwield/plans/store";
import { deepEqual, equal, ok, rejects } from "node:assert/strict";
import { mkdir, stat, writeFile, readFile, mkdtemp, rename, symlink, unlink, link, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { activateRemoteProjectOwner, connectRemotePlanOwner } from "./managed-project-owner.ts";
import type { RemoteInteractiveConfig } from "./entry.ts";
import type { ProjectStoreRequest } from "./project-store-protocol.ts";

const [command, json] = process.argv.slice(2);
interface ComposedRemoteInput extends Pick<RemoteInteractiveConfig, "cwd" | "resources" | "connection"> {
    attemptId?: string;
    planServer?: string;
    planId?: string;
}
const input: ComposedRemoteInput = JSON.parse(json);
const managed = command.startsWith("managed");

interface ManagedAuthoringRevision extends ReviseProjectPlan {
    planId: string;
    planName?: string;
}

type ManagedSourceInterruption = "before-checkpoint" | "after-truncate" | "retry-sync";

async function interruptManagedSource(pathname: string, phase: ManagedSourceInterruption) {
    const { mock } = await import("bun:test");
    const { open } = await import("node:fs/promises");
    mock.module("node:fs/promises", () => ({
        async open(
            path: Parameters<typeof open>[0],
            flags?: Parameters<typeof open>[1],
            mode?: Parameters<typeof open>[2],
        ) {
            const file = await open(path, flags, mode);
            if (path !== pathname) return file;
            if (phase === "before-checkpoint") {
                const write = file.write.bind(file);
                Object.defineProperty(file, "write", {
                    async value(buffer: Buffer, offset: number, length: number, position: number) {
                        equal(offset, 0);
                        equal(position, 0);
                        const prefixLength = 3;
                        ok(length > prefixLength);
                        const result = await write(buffer, offset, prefixLength, position);
                        equal(result.bytesWritten, prefixLength);
                        process.kill(process.pid, "SIGKILL");
                        return result;
                    },
                });
            } else if (phase === "retry-sync") {
                file.sync = () => Promise.reject(new Error("Interrupted while syncing the settled source on retry."));
            } else {
                const truncate = file.truncate.bind(file);
                file.truncate = async (length) => {
                    await truncate(length);
                    file.sync = () => Promise.reject(new Error("Interrupted while syncing the truncated source file."));
                };
            }
            return file;
        },
    }));
}

async function waitForHeldRequestRejection(rejection: Promise<void>): Promise<void> {
    const deadline = Promise.withResolvers<never>();
    const timeout = setTimeout(() => {
        deadline.reject(new Error("The managed request did not reject while its HTTP reply was held."));
    }, 5_000);
    try {
        await Promise.race([rejection, deadline.promise]);
    } finally {
        clearTimeout(timeout);
    }
}

const managedEditDisconnectPhases = [
    "single",
    "prepare",
    "lost",
    "validated-reply",
    "confirmed",
    "redirected",
    "added-link",
    "retargeted",
    "interrupted",
    "short-write",
] as const;
type ManagedEditDisconnectPhase = (typeof managedEditDisconnectPhases)[number];

interface ManagedEditRequests {
    first: string[];
    replacement: string[];
}

interface SourceJournalFixtureRecord {
    sourceIdentity?: string;
    sourceRequest?: string;
    sourceWriteCheckpoint?: { bytesWritten: number } | null;
}

async function qualifyManagedFileEdit(phase: ManagedEditDisconnectPhase): Promise<void> {
    const { mock } = await import("bun:test");
    const transport = await import("./project-store-request.ts");
    const request = transport.authenticatedProjectStoreRequest;
    const requests: ManagedEditRequests = { first: [], replacement: [] };
    let arm = false;
    let activeRoutes = requests.first;
    let replacement: Promise<() => void> | undefined;
    const disconnectAtSource =
        phase === "confirmed" ||
        phase === "redirected" ||
        phase === "added-link" ||
        phase === "retargeted" ||
        phase === "interrupted" ||
        phase === "short-write";
    const cutConnection = () => {
        closeFirst();
        activeRoutes = requests.replacement;
        replacement = connectRemotePlanOwner(input);
        return replacement;
    };
    mock.module("./project-store-request.ts", () => ({
        authenticatedProjectStoreRequest(...args: Parameters<typeof request>): ReturnType<typeof request> {
            const routes = activeRoutes;
            const send = request(...args);
            return async (message, signal) => {
                const kind =
                    message.route === "/project-store"
                        ? (JSON.parse(message.body) as ProjectStoreRequest).command.kind
                        : message.route;
                routes.push(kind);
                const response = await send(message, signal);
                const at =
                    phase === "single" ? "resolve-plan" : phase === "prepare" ? "read-documents" : "edit-documents";
                if (!arm || kind !== at || disconnectAtSource || phase === "validated-reply") return response;
                ok(response.ok);
                arm = false;
                const bytes = new Uint8Array(await response.arrayBuffer());
                const received = new Response(null, { status: response.status });
                // Cut the real connection after the request returned but as the caller receives the reply.
                Object.defineProperty(received, "body", {
                    get() {
                        return new ReadableStream<Uint8Array>({
                            async pull(controller) {
                                await cutConnection();
                                if (phase === "lost") controller.error(new Error("Plan edit reply was lost."));
                                else {
                                    controller.enqueue(bytes);
                                    controller.close();
                                }
                            },
                        });
                    },
                });
                return received;
            };
        },
    }));
    if (phase === "validated-reply") {
        const { ProjectStoreClient } = await import("./project-store-client.ts");
        const execute = ProjectStoreClient.prototype.execute;
        ProjectStoreClient.prototype.execute = async function (command, signal) {
            const reply = await execute.call(this, command, signal);
            if (arm && command.kind === "edit-documents") {
                // The client validated the reply. The caller has yet to receive it.
                arm = false;
                await cutConnection();
            }
            return reply;
        };
    }
    const source = join(input.cwd, "source.txt");
    const renamedSource = join(input.cwd, "original-source.txt");
    const linkedSource = join(input.cwd, "linked-source.txt");
    const requestedSource = phase === "retargeted" ? "source-alias.txt" : "source.txt";
    const alias = join(input.cwd, requestedSource);
    if (phase === "confirmed") await link(source, linkedSource);
    if (phase === "retargeted") {
        await writeFile(renamedSource, "Original source");
        await symlink(source, alias, "file");
    }
    let shortWriteInterrupted = false;
    if (phase === "interrupted" || phase === "short-write") {
        const files = await import("node:fs/promises");
        const open = files.open;
        const { O_RDWR } = await import("node:fs").then(({ constants }) => constants);
        mock.module("node:fs/promises", () => ({
            async open(
                path: Parameters<typeof open>[0],
                flags?: Parameters<typeof open>[1],
                mode?: Parameters<typeof open>[2],
            ) {
                const file = await open(path, flags, mode);
                if (path === source && typeof flags === "number" && (flags & O_RDWR) !== 0) {
                    if (phase === "interrupted") {
                        file.truncate = () =>
                            Promise.reject(new Error("Interrupted before truncating the source file."));
                    } else {
                        const prefixLength = 3;
                        const write = file.write.bind(file);
                        Object.defineProperty(file, "write", {
                            async value(buffer: Buffer, offset: number, length: number, position: number) {
                                equal(length, buffer.length - offset);
                                equal(position, offset);
                                if (offset === 0) {
                                    ok(length > prefixLength);
                                    const result = await write(buffer, offset, prefixLength, position);
                                    equal(result.bytesWritten, prefixLength);
                                    return result;
                                }
                                equal(offset, prefixLength);
                                shortWriteInterrupted = true;
                                throw new Error("Interrupted after writing the source file prefix.");
                            },
                        });
                    }
                }
                return file;
            },
        }));
    }
    const pi = await import("@earendil-works/pi-coding-agent");
    const queue = pi.withFileMutationQueue;
    if (disconnectAtSource) {
        mock.module("@earendil-works/pi-coding-agent", () => ({
            withFileMutationQueue<Result>(path: string, mutate: () => Promise<Result>): Promise<Result> {
                return queue(path, async () => {
                    // The source queue is only entered after the Plan reply has been validated.
                    if (arm && path === source) {
                        arm = false;
                        await cutConnection();
                        if (phase === "redirected") {
                            await rename(source, renamedSource);
                            await symlink(renamedSource, source, "file");
                        }
                        if (phase === "added-link") await link(source, linkedSource);
                        if (phase === "retargeted") {
                            await unlink(alias);
                            await symlink(renamedSource, alias, "file");
                        }
                    }
                    return await mutate();
                });
            },
        }));
    }
    const closeFirst = await activateRemoteProjectOwner(input);
    try {
        const { loadPlan } = await import("../testing/plan-query-fixture.ts");
        const { createMultiFileEditTool } = await import("../../tools/multi_file_edit.ts");
        const tool = createMultiFileEditTool(input.cwd);
        const plan = await loadPlan(input.cwd, "mixed");
        ok(plan);
        const independentDir = await mkdtemp(join(dirname(input.resources.globalRoot), "source-only-"));
        const independent = join(independentDir, "source.txt");
        await writeFile(independent, "Before");
        const sourceOnly = createMultiFileEditTool(independentDir);
        const useSourceOnly = (oldText: string, newText: string) =>
            sourceOnly.execute(
                "source-only",
                {
                    edits: [{ path: "source.txt", oldText, newText }],
                },
                undefined,
                undefined,
                {} as Parameters<typeof sourceOnly.execute>[4],
            );
        const firstCount = requests.first.length;
        equal((await useSourceOnly("Before", "During")).isError, undefined);
        equal(requests.first.length, firstCount);
        arm = true;
        const planEdit = { path: plan.path, oldText: "Original Plan", newText: "Updated Plan" };
        if (phase === "single") {
            const { wrapPlanSafeFileTool } = await import("../../tools/plan-safe-file-tools.ts");
            const { createSingleEditToolDefinition } = await import("../../tools/edit.ts");
            const single = wrapPlanSafeFileTool(createSingleEditToolDefinition(input.cwd), {
                cwd: input.cwd,
                mode: "edit",
            });
            const result = await single.execute(
                "single",
                planEdit,
                undefined,
                undefined,
                {} as Parameters<typeof single.execute>[4],
            );
            ok("isError" in result && result.isError);
        } else {
            const result = await tool.execute(
                "mixed",
                {
                    edits: [{ path: requestedSource, oldText: "Original source", newText: "Updated source" }, planEdit],
                },
                undefined,
                undefined,
                {} as Parameters<typeof tool.execute>[4],
            );
            const succeeds = phase === "confirmed" || phase === "validated-reply";
            equal(Boolean(result.isError), !succeeds, JSON.stringify(result));
        }
        ok(!arm && replacement);
        const closeReplacement = await replacement;
        try {
            deepEqual(requests.replacement, []);
            const expectedSources: Partial<Record<ManagedEditDisconnectPhase, string>> = {
                confirmed: "Updated source",
                "validated-reply": "Updated source",
                interrupted: "Updated sourcee",
                "short-write": "Updginal source",
            };
            const expectedSource = expectedSources[phase] ?? "Original source";
            equal(await readFile(source, "utf8"), expectedSource);
            if (phase === "short-write") ok(shortWriteInterrupted);
            if (phase === "confirmed") equal(await readFile(linkedSource, "utf8"), "Updated source");
            if (phase === "redirected") {
                await unlink(source);
                await rename(renamedSource, source);
            }
            if (phase === "added-link") {
                equal(await readFile(linkedSource, "utf8"), "Original source");
                await unlink(linkedSource);
            }
            if (phase === "retargeted") {
                equal(await readFile(renamedSource, "utf8"), "Original source");
                await unlink(alias);
                await symlink(source, alias, "file");
            }
            closeReplacement();
            const mount = input.resources.globalRoot;
            const detached = `${mount}-detached`;
            await rename(mount, detached);
            try {
                await symlink(mount, mount, "dir");
                equal((await useSourceOnly("During", "After")).isError, undefined);
            } finally {
                await unlink(mount);
                await rename(detached, mount);
            }
            equal(await readFile(independent, "utf8"), "After");
            deepEqual(requests.replacement, []);
        } finally {
            closeReplacement();
        }
    } finally {
        closeFirst();
        if (replacement) (await replacement)();
    }
}

async function qualifyManagedReconnect(): Promise<void> {
    const { projects } = await import("@runwield/projects");
    const { openProjectPlanStore } = await import("../../plan-store/index.ts");
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const oldRoutes: string[] = [];
    const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            const route = new URL(request.url).pathname;
            oldRoutes.push(route);
            const forwarded = new Request(`http://127.0.0.1:${input.connection.port}${route}`, request);
            const response = await fetch(forwarded);
            if (route === "/project-store") {
                const body = await response.text();
                entered.resolve();
                await finish.promise;
                return new Response(body, { status: response.status });
            }
            return response;
        },
    });
    const close = await activateRemoteProjectOwner({
        ...input,
        connection: { ...input.connection, port: proxy.port! },
    });
    try {
        const checkout = projects.checkout.inspect(input.cwd);
        ok(checkout.kind === "existing");
        const old = openProjectPlanStore(checkout.identity.projectId);
        const inFlight = rejects(() => old.list(), /unavailable|abort/i);
        await Promise.race([entered.promise, inFlight]);
        ok(oldRoutes.includes("/project-store"));
        equal(oldRoutes.join(","), "/project-store/inspect,/project-store");
        close();
        const closeNew = await connectRemotePlanOwner(input);
        try {
            await waitForHeldRequestRejection(inFlight);
            const current = openProjectPlanStore(checkout.identity.projectId);
            ok((await current.list()).resources.some((plan) => plan.name === "repeatable"));
            await rejects(() => old.list(), /Managed Plan owner is unavailable/);
            equal(oldRoutes.join(","), "/project-store/inspect,/project-store");
        } finally {
            closeNew();
        }
    } finally {
        finish.resolve();
        close();
        proxy.stop(true);
    }
}

async function qualifyManagedImportReconnect(disconnectAt: "commit" | "result" | "journal-lock"): Promise<void> {
    const heldReply = disconnectAt === "commit" ? "import-plans" : "read-import-result";
    const lockWaiting = Promise.withResolvers<void>();
    const resourceFs = { ...(await import("@runwield/resources/fs")) };
    let journalLockPath: string | undefined;
    let heldJournalLock: ReturnType<typeof resourceFs.openNativeFileLock> | undefined;
    if (disconnectAt === "journal-lock") {
        const { mock } = await import("bun:test");
        mock.module("@runwield/resources/fs", () => ({
            ...resourceFs,
            openNativeFileLock(path: string, create?: boolean | "exclusive") {
                const lock = resourceFs.openNativeFileLock(path, create);
                if (path !== journalLockPath) return lock;
                return {
                    ...lock,
                    async lock(exclusive = false) {
                        if (lock.tryLockSync(exclusive)) return;
                        lockWaiting.resolve();
                        await lock.lock(exclusive);
                    },
                };
            },
        }));
    }
    const { getHomeDir } = await import("../../constants.ts");
    const { importPlans } = await import("../../plan-store/index.ts");
    const source = join(input.cwd, "reconnect-import.md");
    await writeFile(source, "---\nplanId: reconnect-import\nstatus: draft\n---\n# Import once\n");
    const replyReady = Promise.withResolvers<void>();
    const releaseReply = Promise.withResolvers<void>();
    const oldCommands: ProjectStoreRequest["command"][] = [];
    const newCommands: ProjectStoreRequest["command"][] = [];
    let newRequests = 0;

    function proxy(current: boolean) {
        return Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                if (current) newRequests++;
                const route = new URL(request.url).pathname;
                const operation: ProjectStoreRequest | undefined =
                    route === "/project-store" ? await request.clone().json() : undefined;
                if (operation) (current ? newCommands : oldCommands).push(operation.command);
                const forwarded = new Request(`http://127.0.0.1:${input.connection.port}${route}`, request);
                const response = await fetch(forwarded);
                if (!current && operation?.command.kind === heldReply) {
                    equal(response.status, 200);
                    const body = await response.text();
                    replyReady.resolve();
                    await releaseReply.promise;
                    return new Response(body, { status: response.status });
                }
                return response;
            },
        });
    }
    const oldProxy = proxy(false);
    const newProxy = proxy(true);
    const close = await activateRemoteProjectOwner({
        ...input,
        connection: { ...input.connection, port: oldProxy.port! },
    });
    try {
        const failed = rejects(() => importPlans(input.cwd, source), /unavailable|abort/i);
        await Promise.race([replyReady.promise, failed]);
        const [mutation] = oldCommands;
        ok(mutation?.kind === "import-plans");
        const resultRequest = { kind: "read-import-result", operationId: mutation.operationId };
        const expectedCommands = [mutation, resultRequest];
        deepEqual(oldCommands, heldReply === "import-plans" ? [mutation] : expectedCommands);
        const journals = new Bun.Glob("**/managed-operations/managed-operation-*.json");
        let pending: string | undefined;
        for await (const path of journals.scan({ cwd: getHomeDir(), absolute: true, dot: true })) {
            if ((await readFile(path, "utf8")).includes(mutation.operationId)) pending = path;
        }
        ok(pending);
        const originalJournal = await readFile(pending, "utf8");
        if (disconnectAt === "journal-lock") {
            journalLockPath = `${pending}.lock`;
            heldJournalLock = resourceFs.openNativeFileLock(journalLockPath, false);
            ok(heldJournalLock.tryLockSync(true));
            releaseReply.resolve();
            await Promise.race([lockWaiting.promise, failed]);
        }
        close();
        const closeNew = await connectRemotePlanOwner({
            ...input,
            connection: { ...input.connection, port: newProxy.port! },
        });
        try {
            if (disconnectAt === "journal-lock") {
                heldJournalLock?.close();
                heldJournalLock = undefined;
                await failed;
            } else {
                await waitForHeldRequestRejection(failed);
            }
            equal(newRequests, 0);
            equal(await readFile(pending, "utf8"), originalJournal);

            const replay = await importPlans(input.cwd, source);
            equal(replay.kind, "committed");
            deepEqual(replay.planIds, ["reconnect-import"]);
            deepEqual(newCommands, expectedCommands);
            await rejects(stat(pending), { code: "ENOENT" });
        } finally {
            closeNew();
        }
    } finally {
        releaseReply.resolve();
        heldJournalLock?.close();
        close();
        oldProxy.stop(true);
        newProxy.stop(true);
    }
}

async function qualifyManagedPruneReconnect(): Promise<void> {
    const { createHash } = await import("node:crypto");
    const { mock } = await import("bun:test");
    const { checkedProjectRuntimeLayout } = await import("@runwield/project-runtime/layout");
    const { openNativeFileLock } = await import("../native-file-lock.ts");
    const { runPlansCommand } = await import("../../cmd/plans/index.ts");
    const { authorLocalPlan } = await import("../../plan-store/index.ts");
    const lockWaiting = Promise.withResolvers<void>();
    let cleanupLock: string | undefined;
    mock.module("../native-file-lock.ts", () => ({
        openNativeFileLock(path: string, create?: boolean | "exclusive") {
            const lock = openNativeFileLock(path, create);
            if (path !== cleanupLock) return lock;
            return {
                ...lock,
                async lock(exclusive = false) {
                    if (lock.tryLockSync(exclusive)) return;
                    lockWaiting.resolve();
                    await lock.lock(exclusive);
                },
            };
        },
    }));
    const copyName = "prune-owner-switch-copy.md";
    const copy = join(input.cwd, copyName);
    const original = "# Confirmed historical copy\n";
    const digest = createHash("sha256").update(original).digest("hex");
    await writeFile(copy, original);
    const tokens = ["a".repeat(64), "b".repeat(64)];
    const due = tokens.map((token, index) => ({ token, name: `unit-${index + 1}`, paths: [copyName] }));
    const oldCommands: string[] = [];
    const newCommands: string[] = [];
    let newRequests = 0;

    function proxy(current: boolean) {
        return Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                if (current) newRequests++;
                const route = new URL(request.url).pathname;
                if (route === "/project-store") {
                    const { binding, command: operation }: ProjectStoreRequest = await request.clone().json();
                    const commands = current ? newCommands : oldCommands;
                    if (operation.kind === "preview-retention") {
                        commands.push(operation.kind);
                        const text = JSON.stringify({
                            plans: {
                                policy: { retentionDays: 0, keepLast: 0 },
                                due,
                                sparedByKeepLast: [],
                                withinRetention: [],
                                ineligible: [],
                            },
                            records: { due: [] },
                        });
                        const snapshot = createHash("sha256").update(text).digest("hex");
                        return Response.json({
                            binding,
                            result: { retentionPage: { text, snapshot, complete: true } },
                        });
                    }
                    if (operation.kind === "confirm-retention" || operation.kind === "settle-prune-copies") {
                        const first = operation.token === tokens[0];
                        commands.push(`${operation.kind}:${first ? "first" : "second"}`);
                        const copies =
                            operation.kind === "confirm-retention" && first
                                ? [{ path: copyName, repositoryId: binding.repositoryId, digest }]
                                : [];
                        return Response.json({ binding, result: { pruneResult: { deleted: first, copies } } });
                    }
                }
                return await fetch(new Request(`http://127.0.0.1:${input.connection.port}${route}`, request));
            },
        });
    }
    const oldProxy = proxy(false);
    const newProxy = proxy(true);
    const close = await activateRemoteProjectOwner({
        ...input,
        connection: { ...input.connection, port: oldProxy.port! },
    });
    let held: ReturnType<typeof openNativeFileLock> | undefined;
    try {
        await authorLocalPlan(input.cwd, { planName: "prune-admission", contextMarkdown: "# Admitted\n" });
        const runtime = await checkedProjectRuntimeLayout(input.cwd);
        const cleanupDirectory = join(runtime.selected.internalRoot, "prune-copies");
        await mkdir(cleanupDirectory, { recursive: true });
        cleanupLock = join(cleanupDirectory, "cleanup.lock");
        held = openNativeFileLock(cleanupLock);
        ok(held.tryLockSync(true));
        const pending = join(runtime.selected.transitionJournalsDir, "prune-plans.json");
        const rejected = rejects(() => runPlansCommand(["prune", "--yes"]), /unavailable|abort/i);
        await Promise.race([lockWaiting.promise, rejected]);
        const originalRequest = await readFile(pending, "utf8");
        close();
        const closeNew = await connectRemotePlanOwner({
            ...input,
            connection: { ...input.connection, port: newProxy.port! },
        });
        try {
            held.close();
            held = undefined;
            await rejected;
            equal(newRequests, 0);
            equal(await readFile(copy, "utf8"), original);
            equal(await readFile(pending, "utf8"), originalRequest);
            deepEqual(oldCommands, ["preview-retention", "confirm-retention:first"]);

            await runPlansCommand(["prune", "--yes"]);
            await rejects(stat(copy), { code: "ENOENT" });
            await rejects(stat(pending), { code: "ENOENT" });
            deepEqual(newCommands, [
                "confirm-retention:first",
                "settle-prune-copies:first",
                "confirm-retention:second",
            ]);
        } finally {
            closeNew();
        }
    } finally {
        held?.close();
        close();
        oldProxy.stop(true);
        newProxy.stop(true);
    }
}

if (command === "managed-prune-reconnect") {
    await qualifyManagedPruneReconnect();
    process.exit(0);
}

if (command === "managed-connection-reopen") {
    await qualifyManagedReconnect();
    process.exit(0);
}
if (command === "managed-file-edit-reconnect") {
    const phase = managedEditDisconnectPhases.find((phase) => phase === input.attemptId);
    ok(phase);
    await qualifyManagedFileEdit(phase);
    process.exit(0);
}
const importDisconnectPoint = {
    "managed-import-reconnect": "result",
    "managed-import-reconnect-after-commit": "commit",
    "managed-import-reconnect-with-held-lock": "journal-lock",
} as const;
if (Object.hasOwn(importDisconnectPoint, command)) {
    await qualifyManagedImportReconnect(importDisconnectPoint[command as keyof typeof importDisconnectPoint]);
    process.exit(0);
}

const clear = managed ? await activateRemoteProjectOwner(input) : () => {};
try {
    const { openPublication } = await import("@runwield/workflow/publication-runtime");
    const publication = openPublication(input.cwd);
    const {
        publicationCopiesForCheckout,
        selectedPublicationCopies,
        importPlans,
        savePlanProse,
        withLocalPlanWorkflow,
        recordPlanEvent,
        stageValidationPassedInExecutionWorktree,
        settlePackagePublication,
        workRecordsForCheckout,
        readPublishedDeliverySources,
    } = await import("../../plan-store/index.ts");
    const { listPlans, loadPlan } = await import("../testing/plan-query-fixture.ts");
    if (command === "managed-share") {
        const { runPlansShareCommand } = await import("../../cmd/plans/share.ts");
        ok(input.planServer);
        await runPlansShareCommand(["repeatable", "--plan-server", input.planServer]);
    } else if (command === "managed-share-desktop") {
        const { plans } = await import("@runwield/plans");
        const { projects } = await import("@runwield/projects");
        const { openPlanSharing } = await import("../../plan-store/index.ts");
        const checkout = projects.checkout.inspect(input.cwd);
        const planId = plans.identity.parse(input.planId);
        ok(checkout.kind === "existing" && planId && input.planServer);
        const sharing = openPlanSharing({ projectId: checkout.identity.projectId, serverUrl: input.planServer });
        console.log(JSON.stringify(await sharing.share(planId)));
    } else if (command.startsWith("managed-author")) {
        const { openPlanStoreForCheckout, renamePlan, withPlanSubmission } = await import("../../plan-store/index.ts");
        if (command === "managed-author") {
            const planId = await withPlanSubmission(
                input.cwd,
                "repeatable",
                { prepareAuthor: () => ({ contextMarkdown: "# New Plan\n" }) },
                (document) => Promise.resolve(document.planId),
            );
            ok(planId);
            console.log(planId);
        } else if (command === "managed-author-revise" || command === "managed-author-by-reference") {
            const { plans } = await import("@runwield/plans");
            const store = openPlanStoreForCheckout(input.cwd);
            ok(store);
            ok(input.attemptId);
            const revision: ManagedAuthoringRevision = JSON.parse(input.attemptId);
            const { planId: reference, planName, ...changes } = revision;
            const planId = plans.identity.parse(reference);
            ok(planId);
            if (command === "managed-author-by-reference") {
                ok(planName);
                console.log(JSON.stringify(await store.author({ ...changes, planName }, planId)));
            } else {
                console.log(JSON.stringify(await store.revise(planId, changes)));
            }
        } else if (command === "managed-author-legacy-directory") {
            const { enterProjectRuntime } = await import("../project-runtime-layout.ts");
            const runtime = await enterProjectRuntime(input.cwd);
            const directory = join(runtime.selected.transitionJournalsDir, "managed-operations");
            await mkdir(directory, { recursive: true, mode: 0o700 });
            console.log(directory);
        } else if (command === "managed-author-rename") {
            const plan = await loadPlan(input.cwd, "repeatable");
            ok(plan?.attrs.planId);
            await renamePlan(input.cwd, "repeatable", "renamed", plan.revision);
            console.log(plan.attrs.planId);
        }
    } else if (command.startsWith("managed-artifact-")) {
        const { plans } = await import("@runwield/plans");
        const { authorLocalPlan, openPlanStoreForCheckout, reservePlanExecution, saveChildFeaturePlans } =
            await import("../../plan-store/index.ts");
        if (command === "managed-artifact-seed") {
            await authorLocalPlan(input.cwd, {
                planName: "artifact-family",
                contextMarkdown: "# Family\n",
                definition: { classification: "PROJECT", type: "epic" },
            });
            await saveChildFeaturePlans(input.cwd, "artifact-family", [
                {
                    title: "Child",
                    summary: "A child",
                    content: "# Child\n",
                    dependencies: [],
                    order: 1,
                    affectedPaths: ["child.ts"],
                    executionAgent: "engineer",
                    collaborationRecommendation: "autonomous",
                },
            ]);
        } else if (command === "managed-artifact-prepare-qa") {
            const planName = "artifact-family/child";
            await recordPlanEvent({ cwd: input.cwd, planName, event: "review_approved", currentStatus: "draft" });
            await recordPlanEvent({ cwd: input.cwd, planName, event: "readiness_passed", currentStatus: "approved" });
            await withLocalPlanWorkflow(input.cwd, planName, () =>
                reservePlanExecution(planName, { targetBranch: "main" }),
            );
        }
        const store = openPlanStoreForCheckout(input.cwd);
        const epicId = plans.identity.parse((await loadPlan(input.cwd, "artifact-family"))?.attrs.planId);
        ok(store && epicId);
        if (command === "managed-artifact-save") {
            const change: { body: string; revision?: string } = JSON.parse(input.attemptId!);
            console.log(
                JSON.stringify(
                    await store.artifacts.save(epicId, "integration-report.md", change.body, change.revision),
                ),
            );
        } else if (command === "managed-artifact-qa") {
            const childId = plans.identity.parse((await loadPlan(input.cwd, "artifact-family/child"))?.attrs.planId);
            ok(childId);
            const result = await store.artifacts.appendManualQaSection(epicId, childId, {
                childHeading: "Child",
                checklistMarkdown: "Manual verification steps for artifact-family/child\n- [ ] Inspect the child.",
            });
            console.log(result.status);
        } else {
            console.log(JSON.stringify(await store.read(epicId)));
        }
    } else if (command.startsWith("managed-mixed-")) {
        const { authorLocalPlan } = await import("../../plan-store/index.ts");
        if (command === "managed-mixed-seed") {
            await authorLocalPlan(input.cwd, { planName: "mixed", contextMarkdown: "Original Plan" });
            await writeFile(join(input.cwd, "source.txt"), "Original source");
        } else if (command === "managed-mixed-legacy-journal" || command === "managed-mixed-checkpoint-offset") {
            const { enterProjectRuntime } = await import("../project-runtime-layout.ts");
            const directory = join(
                (await enterProjectRuntime(input.cwd)).selected.transitionJournalsDir,
                "managed-file-edits",
            );
            const [name] = (await readdir(directory)).filter((file) => file.endsWith(".json"));
            ok(name);
            const path = join(directory, name);
            const records: SourceJournalFixtureRecord[] = JSON.parse(await readFile(path, "utf8"));
            if (command === "managed-mixed-checkpoint-offset") {
                const source = records.find((record) => record.sourceWriteCheckpoint);
                ok(source?.sourceWriteCheckpoint);
                if (input.attemptId === "null") {
                    source.sourceWriteCheckpoint = null;
                } else {
                    const offset = Number(input.attemptId);
                    ok(Number.isSafeInteger(offset));
                    source.sourceWriteCheckpoint.bytesWritten = offset;
                }
            } else {
                ok(records.some(({ sourceIdentity }) => sourceIdentity));
                for (const record of records) {
                    delete record.sourceIdentity;
                    delete record.sourceRequest;
                }
            }
            await writeFile(path, JSON.stringify(records));
        } else {
            const plan = await loadPlan(input.cwd, "mixed");
            ok(plan);
            if (command === "managed-mixed-inspect")
                console.log(
                    JSON.stringify({
                        body: plan.body,
                        revision: plan.revision,
                        source: await readFile(join(input.cwd, "source.txt"), "utf8"),
                    }),
                );
            else {
                const extraSources =
                    command === "managed-mixed-batch-edit"
                        ? [
                              { path: "clear.txt", oldText: "Remove me", newText: "" },
                              { path: "conflict.txt", oldText: "Before", newText: "After" },
                          ]
                        : [];
                if (
                    command === "managed-mixed-batch-edit" &&
                    (input.attemptId === "before-checkpoint" ||
                        input.attemptId === "after-truncate" ||
                        input.attemptId === "retry-sync")
                )
                    await interruptManagedSource(join(input.cwd, "source.txt"), input.attemptId);
                const { createMultiFileEditTool } = await import("../../tools/multi_file_edit.ts");
                const tool = createMultiFileEditTool(input.cwd);
                const result = await tool.execute(
                    "edit-mixed",
                    {
                        edits: [
                            {
                                path: input.attemptId === "retargeted" ? "source-alias.txt" : "source.txt",
                                oldText: "Original source",
                                newText: "Updated source",
                            },
                            ...extraSources,
                            { path: plan.path, oldText: "Original Plan", newText: "Updated Plan" },
                        ],
                    },
                    new AbortController().signal,
                    () => {},
                    {} as Parameters<typeof tool.execute>[4],
                );
                console.log(JSON.stringify(result));
            }
        }
    } else if (command === "managed-create-project-record") {
        const { openPlanStoreForCheckout } = await import("../../plan-store/index.ts");
        const { recordBody } = await import("../work-records/test-fixtures/package-records.ts");
        const store = openPlanStoreForCheckout(input.cwd);
        ok(store);
        const created = await store.workRecords.create({
            status: "draft",
            scope: "planned_change",
            origin: "external",
            completionMode: "verified",
            body: recordBody,
        });
        ok(!("path" in created));
        equal(created.attrs.status, "draft");
        const read = await store.workRecords.read(created.attrs.recordId.toUpperCase());
        ok(read && !("path" in read));
        deepEqual(read, created);
        const listed = await store.workRecords.list();
        ok(listed.every((record) => !("path" in record)));
        deepEqual(
            listed.find((record) => record.attrs.recordId === created.attrs.recordId),
            created,
        );
        console.log(created.attrs.recordId);
    } else if (command === "managed-edit-documents") {
        const { authorLocalPlan, operatePlanFile, savePlanFileBatch, savePlanProse } =
            await import("../../plan-store/index.ts");
        const prepared = [];
        for (const name of ["first", "second"]) {
            await authorLocalPlan(input.cwd, { planName: name, contextMarkdown: "Original" });
            await recordPlanEvent({ cwd: input.cwd, planName: name, event: "review_approved", currentStatus: "draft" });
            await recordPlanEvent({
                cwd: input.cwd,
                planName: name,
                event: "readiness_passed",
                currentStatus: "approved",
            });
            const plan = await loadPlan(input.cwd, name);
            ok(plan);
            const selected = await operatePlanFile(input.cwd, { path: plan.path, mode: "prepare-edit" });
            ok(selected?.document);
            prepared.push({ ...selected.document, body: "Changed" });
        }
        await savePlanProse(input.cwd, "second", "Intervening edit", prepared[1]!.expectedRevision);
        await rejects(savePlanFileBatch(input.cwd, prepared));
        equal((await loadPlan(input.cwd, "first"))?.revision, prepared[0]!.expectedRevision);
        equal((await loadPlan(input.cwd, "first"))?.attrs.status, "ready_for_work");
        const second = await loadPlan(input.cwd, "second");
        ok(second);
        equal(second.body, "Intervening edit");
        prepared[1]!.expectedRevision = second.revision;
        await savePlanFileBatch(input.cwd, prepared);
        for (const name of ["first", "second"]) {
            const changed = await loadPlan(input.cwd, name);
            equal(changed?.body, "Changed");
            equal(changed?.attrs.status, "draft");
        }
        console.log("verified");
    } else if (command === "manual-prune-seed" || command === "managed-prune" || command === "manual-prune-list") {
        const { runWorkRecordsCommand } = await import("../../cmd/wr/index.ts");
        const { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } = await import("../work-records/mnemoteca-port.ts");
        const { setExactProjectCustomSetting } = await import("../settings.ts");
        if (!managed) process.env.SSH_CONNECTION = "192.0.2.2 54321 192.0.2.1 22";
        if (command === "manual-prune-seed") {
            const { restoreWorkRecordDocument } = await import("../work-records/store.ts");
            const { recordAttrs, recordBody } = await import("../work-records/test-fixtures/package-records.ts");
            await restoreWorkRecordDocument(
                input.cwd,
                recordAttrs({ recordId: "aaaa1111-1111-4111-8111-111111111111" }),
                recordBody,
            );
            setExactProjectCustomSetting("workRecords", { retentionDays: 0, retentionKeepLast: 0 }, input.cwd);
        } else if (managed) {
            await runWorkRecordsCommand(["prune", "--yes"], { mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT });
        } else
            console.log(
                JSON.stringify((await workRecordsForCheckout(input.cwd).list()).map((record) => record.attrs.recordId)),
            );
    } else if (command.startsWith("managed-history-")) {
        const { runPlansCommand } = await import("../../cmd/plans/index.ts");
        const { authorLocalPlan, openPlanStoreForCheckout } = await import("../../plan-store/index.ts");
        if (command === "managed-history-missing") {
            await rejects(runPlansCommand(["history", "missing"]), /requires an admitted Plan/);
            await rejects(
                runPlansCommand(["history", "show", "missing", crypto.randomUUID()]),
                /requires an admitted Plan/,
            );
        } else if (command === "managed-history-seed") {
            await authorLocalPlan(input.cwd, { planName: "proposal", contextMarkdown: "# Original\n" });
            await recordPlanEvent({ cwd: input.cwd, planName: "proposal", event: "review_approved" });
            const store = openPlanStoreForCheckout(input.cwd);
            ok(store);
            const history = await store.history.list(await store.resolveHistoryPlan("proposal"));
            console.log(JSON.stringify(history));
        } else if (command === "managed-history-restore") {
            await runPlansCommand(["history", "restore", "proposal", input.attemptId!]);
        } else if (command === "managed-history-list") {
            await runPlansCommand(["history", "proposal"]);
        } else {
            await runPlansCommand(["history", "show", "proposal", input.attemptId!]);
        }
    } else if (command === "managed-recovery-seed") {
        const { authorLocalPlan, openProjectPlanStore } = await import("../../plan-store/index.ts");
        const { plans } = await import("@runwield/plans");
        const { projects } = await import("@runwield/projects");
        const planName = "recovery";
        await authorLocalPlan(input.cwd, { planName, contextMarkdown: "# Canonical recovery\n" });
        await recordPlanEvent({ cwd: input.cwd, planName, event: "review_approved", currentStatus: "draft" });
        await recordPlanEvent({ cwd: input.cwd, planName, event: "readiness_passed", currentStatus: "approved" });
        const { state } = await openWorkflow({ cwd: input.cwd, planName }).startOrResume();
        const plan = await loadPlan(input.cwd, planName);
        const checkout = projects.checkout.inspect(input.cwd);
        ok(plan && plans.identity.isValid(plan.attrs.planId) && state.worktreeId && checkout.kind === "existing");
        const store = openProjectPlanStore(checkout.identity.projectId);
        const document = await store.read(plan.attrs.planId);
        equal(document.body, "# Canonical recovery\n");
        equal(document.attrs.status, "in_progress");
        equal(document.attrs.worktreeStatus, undefined);
        const { resolveProjectRuntimeLayout } = await import("@runwield/project-runtime/layout");
        const { findById } = await import("../worktree-registry.ts");
        const layout = resolveProjectRuntimeLayout(input.cwd);
        const original = await findById(input.cwd, state.worktreeId);
        ok(original);
        console.log(
            JSON.stringify({
                planId: document.planId,
                attemptId: state.worktreeId,
                original,
                journalDirectory: layout.selected.transitionJournalsDir,
                registryPath: layout.primary.worktreeRegistryPath,
            }),
        );
    } else if (
        command === "managed-recovery-recreate" ||
        command === "managed-recovery-decline-recreate" ||
        command === "managed-recovery-resume-recreate"
    ) {
        const { recreateManagedFixturePlan } = await import("./managed-recreate-fixture.ts");
        const confirmation =
            command === "managed-recovery-recreate"
                ? "confirm"
                : command === "managed-recovery-decline-recreate"
                  ? "cancel"
                  : null;
        console.log(
            JSON.stringify(await recreateManagedFixturePlan(input.cwd, "recovery", confirmation, input.connection)),
        );
    } else if (command === "managed-recovery-abandon") {
        const { updateEntry } = await import("../worktree-registry.ts");
        ok(input.attemptId);
        await updateEntry(input.cwd, input.attemptId, { status: "abandoned" });
    } else if (command === "managed-route-import") {
        const { resolvePlanWithPrimaryRecovery } = await import("../../plan-store/index.ts");
        const selected = join(input.cwd, "docs/plans/explicit.md");
        const original =
            "---\nplanId: explicit-id\nclassification: PLANNED_CHANGE\nstatus: draft\n---\n# Explicit remote source\n";
        await mkdir(join(selected, ".."), { recursive: true });
        await writeFile(selected, original);
        await rejects(resolvePlanWithPrimaryRecovery(input.cwd, "explicit"), /No canonical Plan/);
        equal((await listPlans(input.cwd)).length, 0);
        const imported = await resolvePlanWithPrimaryRecovery(input.cwd, selected);
        equal(imported.plan.attrs.planId, "explicit-id");
        ok(imported.plan.markdown.includes("Explicit remote source"));
        equal(await readFile(selected, "utf8"), original);
        await savePlanProse(input.cwd, "explicit", "# Current canonical prose\n", imported.plan.revision);
        const repeated = await resolvePlanWithPrimaryRecovery(input.cwd, selected);
        ok(repeated.plan.markdown.includes("Current canonical prose"));
        equal((await listPlans(input.cwd)).length, 1);
        equal(await readFile(selected, "utf8"), original);
        console.log(JSON.stringify({ planId: repeated.plan.attrs.planId }));
    } else if (command === "managed-resume") {
        ok(input.attemptId);
        await withLocalPlanWorkflow(input.cwd, "family/first", async () => {
            const attempt = await publication.attempt(input.attemptId!).load();
            ok(attempt);
            ok((await publication.resume(attempt).cleanup()).complete);
        });
        equal((await loadPlan(input.cwd, "family/first"))?.attrs.status, "verified");
        console.log(
            JSON.stringify({
                records: (await workRecordsForCheckout(input.cwd).list()).map((record) => record.attrs.recordId),
            }),
        );
    } else if (command.endsWith("read")) {
        const plan = await loadPlan(input.cwd, "family/second");
        ok(plan);
        ok(plan.markdown.includes(managed ? "Laptop sibling sentinel" : "Remote personal decoy"));
        console.log(
            JSON.stringify({
                planId: plan.attrs.planId,
                revision: plan.revision,
                markdown: plan.markdown,
                path: plan.path,
            }),
        );
    } else {
        const sources = join(input.cwd, managed ? "managed-import" : "manual-import");
        await mkdir(join(sources, "family"), { recursive: true });
        const originals = [
            ["family", "family-id", "classification: PROJECT\ntype: sequence", "Epic scope"],
            ["family/first", "first-id", "classification: PLANNED_CHANGE\nparentPlan: family\norder: 1", "First child"],
            [
                "family/second",
                "second-id",
                "classification: PLANNED_CHANGE\nparentPlan: family\norder: 2",
                managed ? "Original sibling" : "Remote personal decoy",
            ],
        ];
        for (const [name, id, attrs, body] of originals)
            await writeFile(
                join(sources, `${name}.md`),
                `---\nplanId: ${id}\n${name === "family" ? "status: closed_without_verification\nepicCompletionMode: done_enough\nclosedWithoutVerificationReason: Accepted scope" : "status: draft"}\ntargetBranch: main\n${attrs}\n---\n# ${body}\n`,
            );
        equal((await listPlans(input.cwd)).length, command === "manual-deliver" ? 3 : 0);
        equal((await importPlans(input.cwd, sources)).kind, command === "manual-deliver" ? "existing" : "committed");
        await importPlans(input.cwd, sources);
        equal((await listPlans(input.cwd)).length, 3);
        const sibling = await loadPlan(input.cwd, "family/second");
        ok(sibling);
        if (managed) await savePlanProse(input.cwd, "family/second", "# Laptop sibling sentinel\n", sibling.revision);
        if (command === "manual-seed") {
            console.log(
                JSON.stringify({ path: sibling.path, markdown: sibling.markdown, planId: sibling.attrs.planId }),
            );
        } else {
            const { prepareSessionPlanningWorktree } = await import("../workflow/session-planning-worktree.ts");
            const { git } = await import("../git-test-fixture.ts");
            const { publishExecutionWorktreeIsolated } = await import("../isolated-publication.ts");
            const { setExactProjectCustomSetting } = await import("../settings.ts");
            setExactProjectCustomSetting("plans", { deliveryCopies: false }, input.cwd);
            setExactProjectCustomSetting("workRecords", { deliveryCopies: false }, input.cwd);
            const execution = await withLocalPlanWorkflow(input.cwd, "family/first", async () => {
                await recordPlanEvent({
                    cwd: input.cwd,
                    planName: "family/first",
                    event: "review_approved",
                    currentStatus: "draft",
                });
                await recordPlanEvent({
                    cwd: input.cwd,
                    planName: "family/first",
                    event: "readiness_passed",
                    currentStatus: "approved",
                });
                const plan = await loadPlan(input.cwd, "family/first");
                ok(plan);
                const attempt = await openWorkflow({
                    cwd: input.cwd,
                    planName: "family/first",
                    planId: plan.attrs.planId,
                }).startOrResume();
                const execution = attempt.state;
                ok(execution.executionCwd && execution.worktreeId);
                await writeFile(
                    join(execution.executionCwd, managed ? "managed-sentinel" : "manual-sentinel"),
                    "Delivered sentinel\n",
                );
                await attempt.acceptCompletion({});
                for (const event of ["mechanical_validation_passed", "semantic_review_passed"] as const)
                    await recordPlanEvent({
                        cwd: input.cwd,
                        planName: "family/first",
                        event,
                        currentStatus: "implemented",
                    });
                return execution;
            });
            const later = await withLocalPlanWorkflow(input.cwd, "family/second", () =>
                prepareSessionPlanningWorktree(input.cwd, "family/second"),
            );
            ok(later.plan?.markdown.includes(managed ? "Laptop sibling sentinel" : "Remote personal decoy"));
            await withLocalPlanWorkflow(input.cwd, "family/first", async () => {
                await selectedPublicationCopies.freezePolicy("family/first", execution.worktreeId!, {
                    plans: false,
                    workRecords: false,
                    autoGenerateRecords: true,
                });
                const commit = await git(execution.executionCwd!, ["rev-parse", "HEAD"]);
                if (managed) {
                    await rejects(
                        stageValidationPassedInExecutionWorktree({
                            projectRoot: input.cwd,
                            executionCwd: execution.executionCwd!,
                            planName: "family/second",
                            details: { executionMode: "worktree" },
                        }),
                        /Cannot prepare publication.*draft/,
                    );
                    await rejects(
                        stageValidationPassedInExecutionWorktree({
                            projectRoot: input.cwd,
                            executionCwd: execution.executionCwd!,
                            planName: "family/first",
                            details: { executionMode: "worktree", worktreeId: "another-attempt" },
                        }),
                        /another execution attempt/,
                    );
                }
                const staging = await stageValidationPassedInExecutionWorktree({
                    projectRoot: input.cwd,
                    executionCwd: execution.executionCwd!,
                    planName: "family/first",
                    details: {
                        executionMode: "worktree",
                        deliveryEvidence: {
                            version: 1,
                            mode: "worktree_merge",
                            executionCommit: commit,
                            targetBranch: "main",
                            targetHeadBeforeMerge: await git(input.cwd, ["rev-parse", "main"]),
                        },
                    },
                });
                equal(staging.attrs.status, "reviewed");
                ok(staging.planPaths.includes("docs/plans/family/first.md"));
                equal((await loadPlan(input.cwd, "family/first"))?.attrs.status, "reviewed");
                await selectedPublicationCopies.seal("family/first", execution.worktreeId!, commit, "main", true);
                const { autoGenerateWorkRecordForCompletedPlan } = await import("../work-records/auto-generation.ts");
                const { SYSTEM_WORK_RECORD_MNEMOTECA_PORT } = await import("../work-records/mnemoteca-port.ts");
                const recordId = managed ? crypto.randomUUID() : undefined;
                if (recordId) {
                    const { savePlanValidationCheckpoint } = await import("../../plan-store/index.ts");
                    const { recorderCheckpoint } = await import("../work-records/test-fixtures/package-records.ts");
                    const child = await loadPlan(input.cwd, "family/first");
                    ok(child);
                    await savePlanValidationCheckpoint(
                        input.cwd,
                        "family/first",
                        recorderCheckpoint(execution.worktreeId!, execution.executionCwd!, recordId),
                        { expectedRevision: child.revision, expectedControllerRevision: child.controllerRevision },
                    );
                }
                const recorded = await autoGenerateWorkRecordForCompletedPlan({
                    cwd: input.cwd,
                    planName: "family/first",
                    pendingPublication: true,
                    mnemotecaPort: SYSTEM_WORK_RECORD_MNEMOTECA_PORT,
                    runRecorderStep: (prompt) => {
                        const reference: { successorRecordId: string; source: { planId: string } } = JSON.parse(prompt);
                        if (recordId) {
                            equal(reference.successorRecordId, recordId);
                            equal(reference.source.planId, "family-id");
                        }
                        return Promise.resolve({
                            title: managed ? "Laptop composed delivery" : "Manual composed delivery",
                            summary: "Delivered the imported child while preserving its sibling draft.",
                        });
                    },
                });
                ok(recorded.status === "generated" || recorded.status === "linked", JSON.stringify(recorded));
                if (recordId) equal(recorded.recordId, recordId);
                let attempt = await publication.attempt(execution.worktreeId!).start({
                    planName: "family/first",
                    targetBranch: "main",
                    executionBranch: execution.worktreeBranch!,
                    executionCwd: execution.executionCwd!,
                    validatedCommit: commit,
                    targetHeadAtSeal: await git(input.cwd, ["rev-parse", "main"]),
                });
                attempt = await publication.resume(attempt).commitCopies();
                await publishExecutionWorktreeIsolated({
                    projectRoot: input.cwd,
                    executionCwd: attempt.executionCwd,
                    executionBranch: attempt.executionBranch,
                    targetBranch: attempt.targetBranch,
                    planName: attempt.planName,
                    sealedExecutionCommit: attempt.artifactCommit || attempt.validatedCommit,
                    allowedPlanPaths: attempt.planPaths || [],
                    packageInput: attempt.packageInput,
                    publicationRoot: attempt.publicationRoot,
                    onIntegrated: async (proof) => {
                        attempt = await publication.resume(attempt).advance("target_integrated", proof);
                    },
                    onPublished: async (proof) => {
                        attempt = await publication.resume(attempt).advance("target_published", proof);
                    },
                    onVerified: async () => {
                        attempt = await publication.resume(attempt).verify();
                    },
                });
                await settlePackagePublication(input.cwd, attempt);
                equal((await loadPlan(input.cwd, "family/first"))?.attrs.status, "verified");
                const cleanup = await publication.resume(attempt).cleanup();
                ok(cleanup.complete, JSON.stringify(cleanup));
                const delivered = await readPublishedDeliverySources(input.cwd, cleanup.attempt);
                const recordPath = delivered.workRecordOwner?.attrs.workRecord?.path;
                ok(recordPath);
                const record = await publicationCopiesForCheckout(input.cwd).readPublishedWorkRecord(
                    cleanup.attempt,
                    recordPath,
                );
                ok(record?.includes(managed ? "Laptop composed delivery" : "Manual composed delivery"));
                equal(
                    await publicationCopiesForCheckout(input.cwd).readPublishedWorkRecord(
                        cleanup.attempt,
                        "../another-record.md",
                    ),
                    null,
                );
            });
            equal((await loadPlan(input.cwd, "family/first"))?.attrs.status, "verified");
            for (const [name, , , body] of originals)
                ok((await readFile(join(sources, `${name}.md`), "utf8")).includes(`# ${body}`));
            console.log(
                JSON.stringify({
                    executionCwd: execution.executionCwd,
                    attemptId: execution.worktreeId,
                    sibling: (await loadPlan(input.cwd, "family/second"))?.markdown,
                    records: (await workRecordsForCheckout(input.cwd).list()).map((record) => record.attrs.recordId),
                }),
            );
        }
    }
} finally {
    clear();
}
