import { renameSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { projects, ProjectIdentityEntryRequired, type ProjectIdentity } from "@runwield/projects";
import { enter } from "@runwield/project-runtime";
import { invalidateProjectRuntimeReadScope } from "@runwield/project-runtime/layout";
import { ensurePrivateDir, openNativeFileLock, writeJsonAtomically } from "@runwield/resources/fs";
import { assertManagedProjectConnection, matchesManagedOwner } from "./managed-project-connection.ts";
import {
    ProjectStorePreconditionError,
    sameProjectStoreBinding,
    validateProjectStoreBinding,
    type ProjectStoreBinding,
} from "./project-store-wire.ts";
import type { CreateProjectWorkRecord, PackageWorkflowInput } from "./store.ts";
import { operationDigest } from "./operation-receipts.ts";

/** The server admits the launch target. The local journal may use another checkout of that repository. */
async function managedOperationDirectory(
    cwd: string,
    binding: ProjectStoreBinding,
    checkout: ProjectIdentity,
): Promise<string> {
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
        return join((await enter(current)).selected.transitionJournalsDir, "managed-operations");
    } finally {
        invalidateProjectRuntimeReadScope();
    }
}

/** Whether an Epic artifact's retry should reuse an earlier observed revision. */
export type EpicArtifactRevisionSource = "explicit" | "observed";

interface ManagedMutation {
    kind: string;
    operationId: string;
    input?: { expectedRevision?: string } | CreateProjectWorkRecord | PackageWorkflowInput;
    expectedRevision?: string;
    planId?: string;
    version?: string;
    childPlanId?: string;
    childHeading?: string;
    checklistMarkdown?: string;
    resource?: string;
    body?: string;
}

interface RetainedManagedCommand<Command extends ManagedMutation> {
    acknowledged?: boolean;
    binding: ProjectStoreBinding;
    command: Command;
}
interface RetainedMutation<Command extends ManagedMutation> {
    cwd: string;
    binding: ProjectStoreBinding;
    checkout: ProjectIdentity;
    command: Command;
    artifactRevisionSource: EpicArtifactRevisionSource;
}

async function readRetainedManagedCommand<Command extends ManagedMutation>(
    path: string,
): Promise<RetainedManagedCommand<Command>> {
    const retained: RetainedManagedCommand<Command> = JSON.parse(await readFile(path, "utf8"));
    if (!retained || typeof retained !== "object" || Array.isArray(retained))
        throw new Error("Invalid managed operation journal.");
    const fields = Object.keys(retained).sort().join(",");
    if (
        (fields !== "binding,command" && fields !== "acknowledged,binding,command") ||
        ("acknowledged" in retained && typeof retained.acknowledged !== "boolean") ||
        !retained.command ||
        typeof retained.command !== "object" ||
        Array.isArray(retained.command)
    )
        throw new Error("Invalid managed operation journal.");
    validateProjectStoreBinding(retained.binding);
    return retained;
}

function authoringRevision(command: ManagedMutation): string | undefined {
    return command.input && "expectedRevision" in command.input ? command.input.expectedRevision : undefined;
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
        if (command.kind === "author-plan" && !authoringRevision(command))
            return { kind: command.kind, input: command.input };
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

/** Retain the exact mutation across lost acknowledgments and replay it against the same owner. */
export async function executeRetainedManagedMutation<Command extends ManagedMutation, Result>(
    mutation: RetainedMutation<Command>,
    validate: (binding: ProjectStoreBinding, command: Command) => void,
    execute: (command: Command) => Promise<Result>,
): Promise<Result> {
    const { cwd, binding, checkout, command, artifactRevisionSource } = mutation;
    validate(binding, command);
    const repeatableCreation =
        command.kind === "create-project-work-record" ||
        (command.kind === "author-plan" && !authoringRevision(command));
    const artifactMutation = command.kind === "save-epic-artifact" || command.kind === "append-epic-qa";
    const key = managedOperationKey(binding, command, artifactRevisionSource);
    const directory = await managedOperationDirectory(cwd, binding, checkout);
    assertManagedProjectConnection();
    const path = join(directory, `managed-operation-${key}.json`);
    ensurePrivateDir(directory);
    const lock = openNativeFileLock(`${path}.lock`);
    try {
        await lock.lock(true);
        assertManagedProjectConnection();
        let retained: RetainedManagedCommand<Command>;
        try {
            retained = await readRetainedManagedCommand<Command>(path);
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
            assertManagedProjectConnection();
            retained = { binding, command };
            writeJsonAtomically(path, retained);
        }
        assertManagedProjectConnection();
        if (!sameProjectStoreBinding(retained.binding, binding)) throw new Error("Managed operation owner changed.");
        validate(retained.binding, retained.command);
        if (
            !retained.command ||
            retained.command.kind !== command.kind ||
            managedOperationKey(retained.binding, retained.command, artifactRevisionSource) !== key
        )
            throw new Error("Managed operation intent changed.");
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
            if (
                error instanceof ProjectStorePreconditionError &&
                (command.kind === "restore-history" ||
                    artifactMutation ||
                    (command.kind === "author-plan" && authoringRevision(command) === undefined))
            ) {
                assertManagedProjectConnection();
                writeJsonAtomically(path, { ...retained, acknowledged: true });
            }
            throw error;
        });
        // The document batch's validated receipt is enough to settle its prepared source files.
        if (command.kind !== "edit-documents") assertManagedProjectConnection();
        if ((command.kind === "restore-history" || repeatableCreation || artifactMutation) && !retained.acknowledged)
            writeJsonAtomically(path, { ...retained, acknowledged: true });
        return result;
    } finally {
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
    const directory = await managedOperationDirectory(cwd, binding, checkout);
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
        const completed = join(directory, "completed");
        ensurePrivateDir(completed);
        renameSync(path, join(completed, `${operationId}.json`));
    } finally {
        lock.close();
    }
}
