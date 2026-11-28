import { renameSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { projects, ProjectIdentityEntryRequired, type ProjectIdentity } from "@runwield/projects";
import { enter } from "@runwield/project-runtime";
import { invalidateProjectRuntimeReadScope } from "@runwield/project-runtime/layout";
import { ensurePrivateDir, openNativeFileLock, syncParentDirectory, writeJsonAtomically } from "@runwield/resources/fs";
import { assertManagedProjectConnection, matchesManagedOwner } from "./managed-project-connection.ts";
import {
    ProjectStorePreconditionError,
    sameProjectStoreBinding,
    validateProjectStoreBinding,
    type LegacyManagedPlanAuthoring,
    type ProjectStoreBinding,
} from "./project-store-wire.ts";
import type { CreateProjectPlan, CreateProjectWorkRecord, PackageWorkflowInput, ReviseProjectPlan } from "./store.ts";
import { operationDigest } from "./operation-receipts.ts";
import { isPlanId, type PlanId } from "@runwield/plan-storage-format";

/** The server admits the launch target. The local journal may use another checkout of that repository. */
async function managedOperationLayout(cwd: string, binding: ProjectStoreBinding, checkout: ProjectIdentity) {
    invalidateProjectRuntimeReadScope();
    try {
        const info = await stat(cwd).catch((error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
            throw error;
        });
        if (!info?.isDirectory()) throw new Error("Project root must be an existing directory");
        projects.launch.verifyAccountHome(checkout);
        assertManagedProjectConnection();
        const admission = await projects.checkout.admit(cwd);
        if (admission.kind !== "existing") throw new ProjectIdentityEntryRequired(admission);
        const current = admission.identity;
        if (
            !matchesManagedOwner(current, binding) ||
            current.checkoutId !== checkout.checkoutId ||
            current.checkoutRoot !== checkout.checkoutRoot ||
            current.personalOwner.kind !== checkout.personalOwner.kind ||
            current.executionAccountHome !== checkout.executionAccountHome
        )
            throw new Error("Managed Plan request belongs to another execution repository.");
        assertManagedProjectConnection();
        return await enter(current);
    } finally {
        invalidateProjectRuntimeReadScope();
    }
}

/** Whether an Epic artifact's retry should reuse an earlier observed revision. */
export type EpicArtifactRevisionSource = "explicit" | "observed";

interface ManagedMutation {
    kind: string;
    operationId: string;
    input?:
        | CreateProjectPlan
        | ReviseProjectPlan
        | Omit<ReviseProjectPlan, "expectedRevision">
        | CreateProjectWorkRecord
        | PackageWorkflowInput;
    expectedRevision?: string;
    planId?: string;
    version?: string;
    childPlanId?: string;
    childHeading?: string;
    checklistMarkdown?: string;
    resource?: string;
    body?: string;
    intent?: { action: string };
}

interface RetainedManagedCommand<Command extends ManagedMutation> {
    acknowledged?: boolean;
    binding: ProjectStoreBinding;
    command: Command;
    sharePlanId?: PlanId;
}
interface ManagedShareRetry {
    planId: PlanId;
    reference?: string;
    inspectLegacyShare(operationId: string): Promise<LegacyShareEvidence>;
    readCurrentPlan(): Promise<CurrentSharePlan | undefined>;
}
interface LegacyShareEvidence {
    sharePlanId: string | null;
    shareEffectStarted: boolean;
}
interface CurrentSharePlan {
    name: string;
    path: string;
}
interface RetainedMutation<Command extends ManagedMutation> {
    cwd: string;
    binding: ProjectStoreBinding;
    checkout: ProjectIdentity;
    command: Command;
    artifactRevisionSource: EpicArtifactRevisionSource;
    share?: ManagedShareRetry;
}

type ManagedCommandReplay<Command extends ManagedMutation> = Command | LegacyManagedPlanAuthoring;

async function readRetainedManagedCommand<Command extends ManagedMutation>(
    path: string,
): Promise<RetainedManagedCommand<Command>> {
    const retained: RetainedManagedCommand<Command> = JSON.parse(await readFile(path, "utf8"));
    validateRetainedManagedCommand(retained);
    return retained;
}

function validateRetainedManagedCommand(retained: RetainedManagedCommand<ManagedMutation>): void {
    if (!retained || typeof retained !== "object" || Array.isArray(retained))
        throw new Error("Invalid managed operation journal.");
    if (
        Object.keys(retained).some((key) => !["acknowledged", "binding", "command", "sharePlanId"].includes(key)) ||
        ("acknowledged" in retained && typeof retained.acknowledged !== "boolean") ||
        !retained.command ||
        typeof retained.command !== "object" ||
        Array.isArray(retained.command) ||
        ("sharePlanId" in retained &&
            (!isPlanId(retained.sharePlanId) || !isShare(retained.command) || retained.acknowledged))
    )
        throw new Error("Invalid managed operation journal.");
    validateProjectStoreBinding(retained.binding);
}

function authoringRevision(command: ManagedMutation): string | undefined {
    return command.input && "expectedRevision" in command.input ? command.input.expectedRevision : undefined;
}

function isManagedPlanCreation(command: ManagedMutation): boolean {
    return (
        command.kind === "create-plan" || (command.kind === "author-plan" && authoringRevision(command) === undefined)
    );
}

function managedOperationKey(
    binding: ProjectStoreBinding,
    command: ManagedMutation,
    artifactRevisionSource: EpicArtifactRevisionSource,
): string {
    const { operationId: _operationId, ...intent } = command;
    // These retries may observe a newer revision after the original command committed.
    const stableIntent = (() => {
        if (command.kind === "recover-execution" && "action" in command && command.action === "recreate")
            return command;
        if (command.kind === "restore-history")
            return { kind: command.kind, planId: command.planId, version: command.version };
        // Use the previous creation key and lock so an upgrade keeps any pending request's exact IDs.
        if (isManagedPlanCreation(command)) return { kind: "author-plan", input: command.input };
        if (command.kind === "append-epic-qa")
            return {
                kind: command.kind,
                planId: command.planId,
                childPlanId: command.childPlanId,
                childHeading: command.childHeading,
                checklistMarkdown: command.checklistMarkdown,
            };
        if (command.kind === "save-epic-artifact") {
            if (artifactRevisionSource === "observed")
                return { kind: command.kind, planId: command.planId, resource: command.resource, body: command.body };
            // Old generated saves keyed by their observed revision without recording acknowledgment.
            return { ...intent, revisionSource: artifactRevisionSource };
        }
        return intent;
    })();
    return operationDigest(JSON.stringify({ binding, command: stableIntent }));
}

function legacyRevisionKey(binding: ProjectStoreBinding, command: ManagedMutation): string | undefined {
    if (
        command.kind !== "author-plan" ||
        !command.input ||
        typeof command.input !== "object" ||
        !("expectedRevision" in command.input)
    )
        return undefined;
    const { expectedRevision, ...input } = command.input;
    if (!expectedRevision || !("planName" in input)) return undefined;
    const { planName: _name, ...content } = input;
    return managedOperationKey(
        binding,
        {
            kind: "revise-plan",
            operationId: command.operationId,
            planId: command.planId,
            expectedRevision,
            input: content,
        },
        "explicit",
    );
}

// The old revision key included the Plan's name. Search only this checkout's journal for the exact durable request.
async function findLegacyRevisionJournal(directory: string, binding: ProjectStoreBinding, key: string) {
    let match: string | undefined;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^managed-operation-[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        const path = join(directory, entry.name);
        const contents = await readFile(path, "utf8").catch((error) => {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            return undefined;
        });
        if (contents === undefined) continue;
        let prior: RetainedManagedCommand<ManagedMutation>;
        try {
            prior = JSON.parse(contents);
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            continue;
        }
        if (
            !prior?.binding ||
            prior.command?.kind !== "author-plan" ||
            !sameProjectStoreBinding(prior.binding, binding) ||
            legacyRevisionKey(binding, prior.command) !== key
        )
            continue;
        validateRetainedManagedCommand(prior);
        if (entry.name !== `managed-operation-${managedOperationKey(prior.binding, prior.command, "explicit")}.json`)
            throw new Error("Managed operation intent changed.");
        if (match) throw new Error("More than one retained operation matches this Plan revision.");
        match = path;
    }
    return match;
}

interface ManagedShareCommand extends ManagedMutation {
    intent: {
        action: "share";
        options: { planId?: string; target?: string };
    };
}

function isShare(command: ManagedMutation): command is ManagedShareCommand {
    return command.kind === "collaboration" && command.intent?.action === "share";
}

async function pendingOperationFiles(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    });
    return entries
        .filter((entry) => entry.isFile() && /^managed-operation-[a-f0-9]{64}\.json$/.test(entry.name))
        .map((entry) => join(directory, entry.name));
}

async function findLegacyShareJournal(
    executionDirectory: string,
    journalFolder: string,
    binding: ProjectStoreBinding,
    share: ManagedShareRetry,
) {
    const checkoutDirectory = join(executionDirectory, "checkouts");
    const checkouts = await readdir(checkoutDirectory, { withFileTypes: true }).catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
        throw error;
    });
    let match: { path: string; operationId: string } | undefined;
    let currentPlan: Promise<CurrentSharePlan | undefined> | undefined;
    for (const checkout of checkouts.filter((entry) => entry.isDirectory())) {
        const directory = join(checkoutDirectory, checkout.name, journalFolder, "managed-operations");
        for (const path of await pendingOperationFiles(directory)) {
            const prior: RetainedManagedCommand<ManagedMutation> | undefined = await readFile(path, "utf8")
                .then((contents) => JSON.parse(contents))
                .catch((error) => {
                    if (
                        error instanceof SyntaxError ||
                        (error instanceof Error && "code" in error && error.code === "ENOENT")
                    )
                        return undefined;
                    throw error;
                });
            if (!prior?.binding || !prior.command || !isShare(prior.command) || prior.acknowledged) continue;
            if (!sameProjectStoreBinding(prior.binding, binding)) continue;
            if (
                basename(path) !==
                `managed-operation-${managedOperationKey(prior.binding, prior.command, "explicit")}.json`
            )
                continue;
            validateRetainedManagedCommand(prior);
            const { operationId, intent } = prior.command;
            const recordedId = prior.sharePlanId ?? intent.options?.planId;
            const evidence = recordedId ? undefined : await share.inspectLegacyShare(operationId);
            const targetId = recordedId ?? evidence?.sharePlanId;
            if (!targetId && evidence?.shareEffectStarted)
                throw new Error(
                    "A retained share may have published without a durable Plan identity. It was preserved without publishing again.",
                );
            const reference = intent.options?.target;
            if (!targetId && typeof reference === "string") {
                // A present label can reveal ambiguity but cannot authorize historical replay.
                currentPlan ??= share.readCurrentPlan();
                const plan = await currentPlan;
                if ([share.planId, share.reference, plan?.name, plan?.path].includes(reference))
                    throw new Error(
                        "A retained share uses this Plan reference without durable identity. It was preserved without publishing.",
                    );
            }
            if (targetId !== share.planId) continue;
            if (match) throw new Error("More than one retained share matches this Plan.");
            match = { path, operationId };
        }
    }
    return match;
}

async function moveLegacyShareJournal<Command extends ManagedMutation>(
    previous: { path: string; operationId: string },
    destination: string,
    binding: ProjectStoreBinding,
    planId: PlanId,
    validate: (binding: ProjectStoreBinding, command: Command) => void,
): Promise<RetainedManagedCommand<Command> | undefined> {
    const lock = openNativeFileLock(`${previous.path}.lock`);
    try {
        await lock.lock(true);
        const prior = await readRetainedManagedCommand<Command>(previous.path).catch((error) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
            throw error;
        });
        if (!prior) return undefined;
        if (
            prior.command.operationId !== previous.operationId ||
            !sameProjectStoreBinding(prior.binding, binding) ||
            basename(previous.path) !==
                `managed-operation-${managedOperationKey(prior.binding, prior.command, "explicit")}.json`
        )
            throw new Error("Managed operation intent changed.");
        validate(prior.binding, prior.command);
        assertManagedProjectConnection();
        // Move the only pending copy under both locks and preserve the original command.
        const retained = { ...prior, sharePlanId: planId };
        writeJsonAtomically(previous.path, retained);
        renameSync(previous.path, destination);
        syncParentDirectory(destination);
        syncParentDirectory(previous.path);
        return retained;
    } finally {
        lock.close();
    }
}

function completeManagedJournal(directory: string, path: string, operationId: string): void {
    const completed = join(directory, "completed");
    ensurePrivateDir(completed);
    renameSync(path, join(completed, `${operationId}.json`));
}

/** Retain the exact mutation across lost acknowledgments and replay it against the same owner. */
export async function executeRetainedManagedMutation<Command extends ManagedMutation, Result>(
    mutation: RetainedMutation<Command>,
    validate: (binding: ProjectStoreBinding, command: ManagedCommandReplay<Command>) => void,
    execute: (command: ManagedCommandReplay<Command>) => Promise<Result>,
): Promise<Result> {
    const { cwd, binding, checkout, command, artifactRevisionSource, share } = mutation;
    validate(binding, command);
    if (share && (!isShare(command) || command.planId !== share.planId))
        throw new Error("Managed sharing requires a bound Plan.");
    const repeatableCreation = command.kind === "create-project-work-record" || isManagedPlanCreation(command);
    const artifactMutation = command.kind === "save-epic-artifact" || command.kind === "append-epic-qa";
    const key = share
        ? operationDigest(JSON.stringify({ binding, sharePlanId: share.planId }))
        : managedOperationKey(binding, command, artifactRevisionSource);
    const layout = await managedOperationLayout(cwd, binding, checkout);
    const executionDirectory = dirname(layout.primary.worktreeRegistryPath);
    const directory = join(share ? executionDirectory : layout.selected.transitionJournalsDir, "managed-operations");
    assertManagedProjectConnection();
    const path = join(directory, `managed-operation-${key}.json`);
    ensurePrivateDir(directory);
    const lock = openNativeFileLock(`${path}.lock`);
    let legacyLock: ReturnType<typeof openNativeFileLock> | undefined;
    let legacyPath: string | undefined;
    try {
        await lock.lock(true);
        assertManagedProjectConnection();
        let retained: RetainedManagedCommand<ManagedCommandReplay<Command>>;
        try {
            retained = await readRetainedManagedCommand<ManagedCommandReplay<Command>>(path);
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            if (share) {
                const previous = await findLegacyShareJournal(
                    executionDirectory,
                    basename(layout.selected.transitionJournalsDir),
                    binding,
                    share,
                );
                const prior =
                    previous && (await moveLegacyShareJournal(previous, path, binding, share.planId, validate));
                retained = prior ?? { binding, command, sharePlanId: share.planId };
                if (!prior) {
                    assertManagedProjectConnection();
                    writeJsonAtomically(path, retained);
                }
            } else {
                if (command.kind === "revise-plan")
                    legacyPath = await findLegacyRevisionJournal(directory, binding, key);
                if (legacyPath) {
                    legacyLock = openNativeFileLock(`${legacyPath}.lock`);
                    await legacyLock.lock(true);
                    retained = await readRetainedManagedCommand<LegacyManagedPlanAuthoring>(legacyPath);
                } else {
                    assertManagedProjectConnection();
                    retained = { binding, command };
                    writeJsonAtomically(path, retained);
                }
            }
        }
        assertManagedProjectConnection();
        if (!sameProjectStoreBinding(retained.binding, binding)) throw new Error("Managed operation owner changed.");
        validate(retained.binding, retained.command);
        const matched = share
            ? isShare(retained.command) &&
              retained.sharePlanId === share.planId &&
              (retained.command.planId === undefined || retained.command.planId === share.planId)
            : legacyPath
              ? legacyRevisionKey(retained.binding, retained.command) === key &&
                legacyPath ===
                    join(
                        directory,
                        `managed-operation-${managedOperationKey(retained.binding, retained.command, "explicit")}.json`,
                    )
              : (retained.command.kind === command.kind ||
                    (command.kind === "create-plan" && isManagedPlanCreation(retained.command))) &&
                managedOperationKey(retained.binding, retained.command, artifactRevisionSource) === key;
        if (!matched) throw new Error("Managed operation intent changed.");
        if (
            retained.acknowledged &&
            (repeatableCreation ||
                artifactMutation ||
                (command.kind === "restore-history" &&
                    retained.command.kind === "restore-history" &&
                    retained.command.expectedRevision !== command.expectedRevision))
        ) {
            assertManagedProjectConnection();
            retained = { binding, command };
            writeJsonAtomically(path, retained);
        }
        const result = await execute(retained.command).catch((error) => {
            if (share && retained.command.planId === share.planId && error instanceof ProjectStorePreconditionError) {
                assertManagedProjectConnection();
                completeManagedJournal(directory, path, retained.command.operationId);
            }
            if (
                error instanceof ProjectStorePreconditionError &&
                (command.kind === "restore-history" || artifactMutation || isManagedPlanCreation(command))
            ) {
                assertManagedProjectConnection();
                writeJsonAtomically(path, { ...retained, acknowledged: true });
            }
            throw error;
        });
        // The document batch's validated receipt is enough to settle its prepared source files.
        if (command.kind !== "edit-documents") assertManagedProjectConnection();
        if (share) completeManagedJournal(directory, path, retained.command.operationId);
        if ((command.kind === "restore-history" || repeatableCreation || artifactMutation) && !retained.acknowledged)
            writeJsonAtomically(path, { ...retained, acknowledged: true });
        return result;
    } finally {
        legacyLock?.close();
        lock.close();
    }
}

/** Move an acknowledged import or collaboration mutation out of the pending journal. */
export async function acknowledgeManagedMutation<Intent extends { kind: "collaboration" | "import-plans" }>(
    cwd: string,
    binding: ProjectStoreBinding,
    checkout: ProjectIdentity,
    intent: Intent,
    operationId: string,
): Promise<void> {
    const key = operationDigest(JSON.stringify({ binding, command: intent }));
    const layout = await managedOperationLayout(cwd, binding, checkout);
    const directory = join(layout.selected.transitionJournalsDir, "managed-operations");
    assertManagedProjectConnection();
    const path = join(directory, `managed-operation-${key}.json`);
    const lock = openNativeFileLock(`${path}.lock`);
    try {
        await lock.lock(true);
        assertManagedProjectConnection();
        const pending = await readRetainedManagedCommand(path).catch((error) => {
            if (intent.kind === "collaboration" && error instanceof Error && "code" in error && error.code === "ENOENT")
                return undefined;
            throw error;
        });
        assertManagedProjectConnection();
        if (pending?.command.operationId !== operationId) return;
        if (!sameProjectStoreBinding(pending.binding, binding)) throw new Error("Managed operation owner changed.");
        if (managedOperationKey(pending.binding, pending.command, "explicit") !== key)
            throw new Error("Managed operation intent changed.");
        completeManagedJournal(directory, path, operationId);
    } finally {
        lock.close();
    }
}
