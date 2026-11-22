import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopNavigation } from "../workspace/client/desktop-workbench.ts";
import type { DesktopDraftLocator } from "./draft-store.ts";

export const DEFAULT_NAVIGATION: DesktopNavigation = {
    collapsed: false,
    expandedProjects: [],
    selectedProjectId: "",
    selectedSessionId: "",
    showSession: false,
};
export function validateNavigation(value: DesktopNavigation): void {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !Object.keys(DEFAULT_NAVIGATION).includes(key)) ||
        typeof value.collapsed !== "boolean" ||
        typeof value.showSession !== "boolean" ||
        !Array.isArray(value.expandedProjects) ||
        value.expandedProjects.length > 1000 ||
        value.expandedProjects.some((id) => typeof id !== "string" || !id || id.length > 512) ||
        [value.selectedProjectId, value.selectedSessionId].some((id) => typeof id !== "string" || id.length > 512)
    )
        throw new Error("Invalid desktop navigation preferences.");
}
export interface DesktopBounds {
    x?: number;
    y?: number;
    width: number;
    height: number;
}
export interface DesktopRecoveryNotice extends DesktopDraftLocator {
    message: string;
}
interface PreferencesFile {
    version: 1;
    navigation: DesktopNavigation;
    bounds: DesktopBounds;
    bindings: DesktopDraftLocator[];
    recoveryNotices: DesktopRecoveryNotice[];
}
/** Main owns private atomic projections; none grant Project or Session access. */
export class DesktopPreferences {
    private state: PreferencesFile = {
        version: 1,
        navigation: { ...DEFAULT_NAVIGATION },
        bounds: { width: 1440, height: 900 },
        bindings: [],
        recoveryNotices: [],
    };
    private pending: Promise<void> = Promise.resolve();
    private constructor(private directory: string) {}
    static async open(userData: string): Promise<DesktopPreferences> {
        const store = new DesktopPreferences(join(userData, "desktop-preferences"));
        await mkdir(store.directory, { recursive: true, mode: 0o700 });
        await chmod(store.directory, 0o700);
        try {
            const path = join(store.directory, "preferences.json");
            await chmod(path, 0o600);
            const file = JSON.parse(await readFile(path, "utf8")) as PreferencesFile;
            validateNavigation(file.navigation);
            file.recoveryNotices ||= [];
            if (
                !Array.isArray(file.recoveryNotices) ||
                file.recoveryNotices.some(
                    (notice) =>
                        typeof notice.message !== "string" ||
                        notice.message.length > 4000 ||
                        [notice.projectId, notice.composerKey, notice.durableSessionId].some(
                            (id) => typeof id !== "string" || id.length > 512,
                        ),
                )
            )
                throw new Error("Invalid recovery evidence.");
            if (
                file.version !== 1 ||
                !Array.isArray(file.bindings) ||
                file.bindings.some(
                    (binding) =>
                        [binding.projectId, binding.composerKey].some(
                            (id) => typeof id !== "string" || !id || id.length > 512,
                        ) ||
                        typeof binding.durableSessionId !== "string" ||
                        binding.durableSessionId.length > 512,
                ) ||
                !file.bounds ||
                !Number.isFinite(file.bounds.width) ||
                !Number.isFinite(file.bounds.height) ||
                file.bounds.width < 700 ||
                file.bounds.height < 550 ||
                [file.bounds.x, file.bounds.y].some((n) => n !== undefined && !Number.isFinite(n))
            )
                throw new Error("Invalid desktop preferences.");
            store.state = file;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                await rename(
                    join(store.directory, "preferences.json"),
                    join(store.directory, `preferences-corrupt-${randomUUID()}.json`),
                );
        }
        return store;
    }
    read(): PreferencesFile {
        return structuredClone(this.state);
    }
    update(patch: Partial<Omit<PreferencesFile, "version">>): Promise<void> {
        const next = structuredClone(patch);
        const operation = this.pending.then(async () => {
            const state = { ...this.state, ...next };
            if (JSON.stringify(state) === JSON.stringify(this.state)) return;
            const path = join(this.directory, "preferences.json");
            const temporary = join(this.directory, `.preferences-${randomUUID()}.tmp`);
            const file = await open(temporary, "wx", 0o600);
            try {
                await file.writeFile(JSON.stringify(state));
                await file.sync();
            } finally {
                await file.close();
            }
            try {
                await rename(temporary, path);
                const directory = await open(this.directory, "r");
                try {
                    await directory.sync();
                } finally {
                    await directory.close();
                }
                this.state = state;
            } finally {
                await unlink(temporary).catch(() => {});
            }
        });
        this.pending = operation.catch(() => {});
        return operation;
    }
    async flush(): Promise<void> {
        await this.pending;
    }
}
