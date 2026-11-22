import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { SessionQueuedDraft } from "../workspace/client/session-client.ts";
import type { SessionComposerDraft } from "../workspace/client/session-drafts.ts";
import { validateComposer } from "./draft-bridge.ts";
import { validateSessionInput } from "../../shared/session/session-input-contract.ts";

/** Restorable locators only. Wire connection IDs are never durable authority. */
export interface DesktopDraftLocator {
    projectId: string;
    durableSessionId: string;
    composerKey: string;
}
export interface DesktopSubmittedDraft extends SessionQueuedDraft {
    expectedGeneration: number;
    kind: "prompt" | "steering" | "bootstrap";
}
export interface DesktopDraftEntry extends DesktopDraftLocator {
    composer: SessionComposerDraft | null;
    queued: SessionQueuedDraft[];
    submitted: DesktopSubmittedDraft[];
}
interface DraftFile {
    version: 1;
    entries: DesktopDraftEntry[];
    retired: string[];
    notice: string;
    removedProjects: string[];
    aliases?: Record<string, string>;
}
function key(locator: DesktopDraftLocator): string {
    return JSON.stringify([locator.projectId, locator.durableSessionId || locator.composerKey]);
}
function validLocator(locator: DesktopDraftLocator): void {
    for (const value of [locator.projectId, locator.composerKey])
        if (typeof value !== "string" || !value || value.length > 512) throw new Error("Invalid draft locator.");
    if (typeof locator.durableSessionId !== "string" || locator.durableSessionId.length > 512)
        throw new Error("Invalid durable draft locator.");
}
/** Single main-process owner; every mutation commits before it returns. */
export class DesktopDraftStore {
    readonly directory: string;
    readonly path: string;
    private state: DraftFile = { version: 1, entries: [], retired: [], notice: "", removedProjects: [] };
    private pending: Promise<void> = Promise.resolve();
    private constructor(userData: string) {
        this.directory = join(userData, "desktop-intent");
        this.path = join(this.directory, "drafts.json");
    }
    static async open(userData: string): Promise<DesktopDraftStore> {
        const store = new DesktopDraftStore(userData);
        await mkdir(store.directory, { recursive: true, mode: 0o700 });
        await chmod(store.directory, 0o700);
        try {
            await chmod(store.path, 0o600);
            const file = JSON.parse(await readFile(store.path, "utf8")) as DraftFile;
            if (
                file.version !== 1 ||
                !Array.isArray(file.entries) ||
                !Array.isArray(file.retired) ||
                file.retired.some((id) => typeof id !== "string") ||
                typeof file.notice !== "string" ||
                (file.aliases !== undefined &&
                    (!file.aliases ||
                        typeof file.aliases !== "object" ||
                        Array.isArray(file.aliases) ||
                        Object.values(file.aliases).some((value) => typeof value !== "string"))) ||
                !Array.isArray(file.removedProjects) ||
                file.removedProjects.some((id) => typeof id !== "string")
            )
                throw new Error("Invalid draft store.");
            const keys = new Set<string>();
            for (const entry of file.entries) {
                validLocator(entry);
                if (keys.has(key(entry)) || !Array.isArray(entry.queued) || !Array.isArray(entry.submitted))
                    throw new Error("Invalid draft entries.");
                keys.add(key(entry));
                if (entry.composer !== null) validateComposer(entry.composer);
                for (const submitted of entry.submitted) {
                    if (
                        !Number.isSafeInteger(submitted.expectedGeneration) ||
                        submitted.expectedGeneration < 0 ||
                        !["prompt", "steering", "bootstrap"].includes(submitted.kind)
                    )
                        throw new Error("Invalid submitted receipt metadata.");
                }
                for (const draft of [...entry.queued, ...entry.submitted]) {
                    validateSessionInput(draft.text, draft.images);
                    if (typeof draft.requestId !== "string" || !draft.requestId || draft.requestId.length > 128)
                        throw new Error("Invalid queued draft identity.");
                }
            }
            store.state = file;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                // Never overwrite the damaged private input. Keep both its bytes and a durable notice.
                const preserved = join(store.directory, `drafts-corrupt-${randomUUID()}.json`);
                await rename(store.path, preserved);
                await chmod(preserved, 0o600);
                store.state.notice = `Saved drafts could not be read. A private recovery copy was preserved at ${preserved}.`;
                await store.commit();
            }
        }
        return store;
    }
    async list(): Promise<DesktopDraftEntry[]> {
        await this.pending;
        return structuredClone(this.state.entries);
    }
    async read(locator: DesktopDraftLocator): Promise<DesktopDraftEntry | null> {
        await this.pending;
        return structuredClone(this.state.entries.find((entry) => key(entry) === key(locator)) || null);
    }
    get notice(): string {
        return this.state.notice;
    }
    private mutate(update: () => void): Promise<void> {
        const operation = this.pending.then(async () => {
            const previous = structuredClone(this.state);
            try {
                update();
                await this.commit();
            } catch (error) {
                this.state = previous;
                throw error;
            }
        });
        this.pending = operation.catch(() => {});
        return operation;
    }
    private entry(locator: DesktopDraftLocator): DesktopDraftEntry {
        validLocator(locator);
        if (this.state.removedProjects.includes(locator.projectId))
            throw new Error("Project registration was removed.");
        let entry = this.state.entries.find((item) => key(item) === key(locator));
        if (!entry) {
            entry = { ...locator, composer: null, queued: [], submitted: [] };
            this.state.entries.push(entry);
        }
        return entry;
    }
    private retirementKey(locator: DesktopDraftLocator, requestId: string): string {
        let scope = key(locator);
        const seen = new Set<string>();
        while (this.state.aliases?.[scope] && !seen.has(scope)) {
            seen.add(scope);
            scope = this.state.aliases[scope];
        }
        return JSON.stringify([scope, requestId]);
    }
    private moveRetirement(previous: DesktopDraftLocator, next: DesktopDraftLocator) {
        const before = key(previous);
        const after = key(next);
        if (before === after) return;
        this.state.aliases ||= {};
        for (const [alias, target] of Object.entries(this.state.aliases))
            if (target === before) this.state.aliases[alias] = after;
        this.state.aliases[before] = after;
        this.state.retired = this.state.retired.map((value) => {
            const [scope, requestId] = JSON.parse(value) as [string, string];
            return scope === before ? JSON.stringify([after, requestId]) : value;
        });
    }
    write(locator: DesktopDraftLocator, composer: SessionComposerDraft): Promise<void> {
        validateComposer(composer);
        return this.mutate(() => {
            if (
                this.state.retired.includes(this.retirementKey(locator, composer.requestId)) ||
                this.entry(locator).queued.some((item) => item.requestId === composer.requestId)
            )
                return;
            this.entry(locator).composer = composer.text || composer.images.length ? structuredClone(composer) : null;
        });
    }
    queue(locator: DesktopDraftLocator, draft: SessionQueuedDraft): Promise<void> {
        validateSessionInput(draft.text, draft.images);
        if (!draft.requestId || draft.requestId.length > 128) throw new Error("Invalid queued request ID.");
        return this.mutate(() => {
            if (this.state.retired.includes(this.retirementKey(locator, draft.requestId))) return;
            const entry = this.entry(locator);
            entry.queued = [
                ...entry.queued.filter((item) => item.requestId !== draft.requestId),
                structuredClone(draft),
            ];
            if (entry.composer?.requestId === draft.requestId) entry.composer = null;
        });
    }
    submit(locator: DesktopDraftLocator, draft: DesktopSubmittedDraft): Promise<void> {
        validateSessionInput(draft.text, draft.images);
        return this.mutate(() => {
            if (this.state.retired.includes(this.retirementKey(locator, draft.requestId)))
                throw new Error("This input was already accepted or discarded. Use a new request identity.");
            const entry = this.entry(locator);
            if (!entry.submitted.some((item) => item.requestId === draft.requestId))
                entry.submitted.push(structuredClone(draft));
        });
    }
    editQueued(locator: DesktopDraftLocator, requestId: string): Promise<SessionComposerDraft> {
        let composer: SessionComposerDraft;
        return this.mutate(() => {
            const entry = this.entry(locator);
            if (entry.composer?.text || entry.composer?.images.length)
                throw new Error("Keep or send the current draft first.");
            const draft = entry.queued.find((item) => item.requestId === requestId);
            if (!draft) throw new Error("Unknown queued draft.");
            composer = {
                text: draft.text,
                requestId,
                images: draft.images.map((image) => ({ ...image, id: randomUUID(), name: "Queued image" })),
            };
            entry.composer = composer;
            entry.queued = entry.queued.filter((item) => item.requestId !== requestId);
        }).then(() => structuredClone(composer));
    }
    accepted(locator: DesktopDraftLocator, requestId: string): Promise<void> {
        return this.mutate(() => {
            if (!this.state.retired.includes(this.retirementKey(locator, requestId)))
                this.state.retired.push(this.retirementKey(locator, requestId));
            const entry = this.state.entries.find((item) => key(item) === key(locator));
            if (!entry) return;
            if (entry.composer?.requestId === requestId) entry.composer = null;
            entry.queued = entry.queued.filter((item) => item.requestId !== requestId);
            entry.submitted = entry.submitted.filter((item) => item.requestId !== requestId);
        });
    }
    discard(locator: DesktopDraftLocator): Promise<void> {
        return this.mutate(() => {
            const entry = this.state.entries.find((item) => key(item) === key(locator));
            if (!entry?.composer) return;
            const requestId = entry.composer.requestId;
            this.state.retired.push(this.retirementKey(locator, requestId));
            entry.composer = null;
            entry.queued = entry.queued.filter((item) => item.requestId !== requestId);
            entry.submitted = entry.submitted.filter((item) => item.requestId !== requestId);
        });
    }
    removeProject(projectId: string): Promise<void> {
        return this.mutate(() => {
            if (!this.state.removedProjects.includes(projectId)) this.state.removedProjects.push(projectId);
            this.state.entries = this.state.entries.filter((entry) => entry.projectId !== projectId);
        });
    }
    /** Step 8 uses this after admitting the same Project and reopening/recreating its binding. */
    restoreBinding(previous: DesktopDraftLocator, next: DesktopDraftLocator): Promise<void> {
        validLocator(previous);
        validLocator(next);
        if (previous.projectId !== next.projectId) throw new Error("Drafts cannot move between Projects.");
        return this.mutate(() => {
            const entry = this.state.entries.find((item) => key(item) === key(previous));
            this.moveRetirement(previous, next);
            if (!entry) return;
            if (key(previous) !== key(next) && this.state.entries.some((item) => key(item) === key(next)))
                throw new Error("The destination already has unsent intent.");
            Object.assign(entry, next);
        });
    }
    /** Reconcile a pre-acceptance composer with the durable identity learned from Core. */
    bind(locator: DesktopDraftLocator): Promise<void> {
        return this.mutate(() => {
            const composer = this.state.entries.find(
                (entry) =>
                    entry.projectId === locator.projectId &&
                    entry.composerKey === locator.composerKey &&
                    !entry.durableSessionId,
            );
            if (!locator.durableSessionId) return;
            if (!composer) {
                this.moveRetirement({ ...locator, durableSessionId: "" }, locator);
                return;
            }
            this.moveRetirement(composer, locator);
            const durable = this.state.entries.find((entry) => key(entry) === key(locator));
            if (durable && durable !== composer) {
                durable.composer ||= composer.composer;
                durable.submitted.push(
                    ...composer.submitted.filter(
                        (item) => !durable.submitted.some((old) => old.requestId === item.requestId),
                    ),
                );
                durable.queued.push(
                    ...composer.queued.filter(
                        (item) => !durable.queued.some((old) => old.requestId === item.requestId),
                    ),
                );
                this.state.entries = this.state.entries.filter((entry) => entry !== composer);
            } else composer.durableSessionId = locator.durableSessionId;
        });
    }
    async flush(): Promise<void> {
        await this.pending;
    }
    private async commit(): Promise<void> {
        this.state.entries = this.state.entries.filter(
            (entry) => entry.composer || entry.queued.length || entry.submitted.length,
        );
        const temporary = join(this.directory, `.drafts-${randomUUID()}.tmp`);
        const file = await open(temporary, "wx", 0o600);
        try {
            await file.writeFile(JSON.stringify(this.state));
            await file.sync();
        } finally {
            await file.close();
        }
        try {
            await rename(temporary, this.path);
            const directory = await open(this.directory, "r");
            try {
                await directory.sync();
            } finally {
                await directory.close();
            }
        } finally {
            await unlink(temporary).catch(() => {});
        }
    }
}
