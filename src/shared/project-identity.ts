/** Stable Core identity. Inspection never writes; admission owns all identity mutations. */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
    closeSync,
    fsyncSync,
    lstatSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getHomeDir } from "../constants.js";
import { openNativeFileLock } from "./native-file-lock.ts";
import { ensurePrivateDir, syncParentDirectory, writeJsonAtomically } from "./private-json-file.ts";
import { remoteProjectOwner } from "./remote/personal-resources.ts";

export interface ProjectPersonalOwner {
    kind: "execution-account" | "managed-remote";
    /** Explicit laptop account identity for managed launches; account home for ordinary launches. */
    identity: string;
}
export interface ProjectLaunchContext {
    personalOwner: ProjectPersonalOwner;
    executionAccountHome: string;
}
export interface ProjectIdentity {
    projectId: string;
    personalOwner: ProjectPersonalOwner;
    executionAccountHome: string;
    repositoryId: string;
    checkoutId: string;
    cwd: string;
    checkoutRoot: string;
}
export interface ProjectIdentityCandidate {
    projectId: string;
    displayName: string;
    remote: string;
}
export interface ProjectIdentityPending {
    kind: "pending";
    candidates: ProjectIdentityCandidate[];
}
export interface ProjectIdentityInvalid {
    kind: "invalid";
    message: string;
}
export interface ProjectIdentityExisting {
    kind: "existing";
    identity: ProjectIdentity;
}
export interface ProjectIdentityFresh {
    kind: "fresh";
}
export interface ProjectIdentityCanceled {
    kind: "canceled";
}
export type ProjectIdentityInspection =
    ProjectIdentityExisting | ProjectIdentityFresh | ProjectIdentityPending | ProjectIdentityInvalid;
export type ProjectIdentityAdmission = ProjectIdentityInspection | ProjectIdentityCanceled;
export interface ProjectCloneChoice {
    kind: "link" | "new" | "cancel";
    /** Exact candidate evidence shown to the person; admission revalidates it. */
    candidates: ProjectIdentityCandidate[];
    projectId?: string;
}
export interface ProjectIdentityOptions {
    context?: ProjectLaunchContext;
    choice?: ProjectCloneChoice;
}
interface IdentityMarker {
    format: "runwield-project";
    version: 1;
    projectId: string;
    repositoryId: string;
    checkoutId: string;
}
interface RepositoryBinding {
    repositoryId: string;
    remote: string | null;
    decision: "new" | "linked";
    checkouts: CheckoutBinding[];
}
interface CheckoutBinding {
    checkoutId: string;
    root: string;
}
interface ProjectRecord {
    version: 1;
    projectId: string;
    displayName: string;
    personalOwner: ProjectPersonalOwner;
    repositories: RepositoryBinding[];
}
interface IdentityEvidence {
    cwd: string;
    root: string;
    common?: string;
    admin?: string;
    marker: IdentityMarker | null;
    projectId: string | null;
    repositoryId: string | null;
    checkoutId: string | null;
    remote: string | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function requireId(value: string, label: string): string {
    if (typeof value !== "string" || !uuid.test(value)) throw new Error(`Invalid ${label}`);
    return value;
}
function missing(error: Error): boolean {
    return "code" in error && error.code === "ENOENT";
}
function regularFile(path: string): boolean {
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error(`Identity evidence must be a regular file: ${path}`);
        return true;
    } catch (error) {
        if (error instanceof Error && missing(error)) return false;
        throw error;
    }
}
function git(cwd: string, args: string[], absent = false): string | null {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10000 });
    if (result.error) throw result.error;
    if (result.status === 0) return result.stdout.trim();
    if (absent && result.status === 1) return null;
    throw new Error(`Cannot read Project Git identity: ${result.stderr.trim() || result.status}`);
}
function config(cwd: string, file: string, key: string): string | null {
    if (!regularFile(file)) return null;
    const value = git(cwd, ["config", "--file", file, "--no-includes", "--get-all", key], true);
    if (value?.includes("\n")) throw new Error(`Multiple values for identity key ${key} in ${file}`);
    return value;
}
function markerAt(path: string): IdentityMarker | null {
    if (!regularFile(path)) return null;
    const marker: IdentityMarker = JSON.parse(readFileSync(path, "utf8"));
    if (
        !marker ||
        marker.format !== "runwield-project" ||
        marker.version !== 1 ||
        Object.keys(marker).sort().join() !== "checkoutId,format,projectId,repositoryId,version"
    ) {
        throw new Error(`Unrecognized Project marker: ${path}`);
    }
    requireId(marker.projectId, `Project ID in ${path}`);
    requireId(marker.repositoryId, `repository ID in ${path}`);
    requireId(marker.checkoutId, `checkout ID in ${path}`);
    return marker;
}
function evidence(path: string): IdentityEvidence {
    const cwd = realpathSync(path);
    if (!lstatSync(cwd).isDirectory()) throw new Error("Project root must be a directory");
    // A non-repository exit is distinguished from other Git failures by filesystem evidence.
    const probe = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 10000 });
    if (probe.error) throw probe.error;
    if (probe.status !== 0 && !probe.stderr.includes("not a git repository"))
        throw new Error(`Cannot inspect Project Git directory: ${probe.stderr}`);
    let root = probe.status === 0 ? realpathSync(probe.stdout.trim()) : cwd;
    if (probe.status !== 0) {
        for (let ancestor = cwd; ; ancestor = dirname(ancestor)) {
            if (regularFile(join(ancestor, ".wld-project.json"))) {
                root = ancestor;
                break;
            }
            if (dirname(ancestor) === ancestor) break;
        }
    }
    const marker = markerAt(join(root, ".wld-project.json"));
    if (probe.status !== 0)
        return {
            cwd,
            root,
            marker,
            projectId: marker?.projectId ?? null,
            repositoryId: marker?.repositoryId ?? null,
            checkoutId: marker?.checkoutId ?? null,
            remote: null,
        };
    const common = realpathSync(resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"])!));
    const admin = realpathSync(resolve(cwd, git(cwd, ["rev-parse", "--git-dir"])!));
    const file = join(common, "config");
    const projectId = config(cwd, file, "runwield.projectId");
    const repositoryId = config(cwd, file, "runwield.repositoryId");
    const checkoutPath = join(admin, "runwield-checkout-id");
    const checkoutId = regularFile(checkoutPath)
        ? requireId(readFileSync(checkoutPath, "utf8").trim(), "checkout ID")
        : null;
    if (projectId !== null) requireId(projectId, "Git Project ID");
    if (repositoryId !== null) requireId(repositoryId, "Git repository ID");
    if (
        marker &&
        ((projectId && projectId !== marker.projectId) ||
            (repositoryId && repositoryId !== marker.repositoryId) ||
            (checkoutId && checkoutId !== marker.checkoutId))
    )
        throw new Error("Project marker conflicts with Git identity; both were preserved");
    if (!projectId && repositoryId) throw new Error("Git repository binding has no Project ID");
    return {
        cwd,
        root,
        common,
        admin,
        marker,
        projectId: projectId ?? marker?.projectId ?? null,
        repositoryId: repositoryId ?? marker?.repositoryId ?? null,
        checkoutId: checkoutId ?? marker?.checkoutId ?? null,
        remote: git(cwd, ["config", "--file", file, "--no-includes", "--get", "remote.origin.url"], true),
    };
}
export function projectLaunchContext(): ProjectLaunchContext {
    const executionAccountHome = getHomeDir();
    return {
        executionAccountHome,
        personalOwner: remoteProjectOwner() ?? { kind: "execution-account", identity: executionAccountHome },
    };
}
function contextFor(options: ProjectIdentityOptions): ProjectLaunchContext {
    const context = options.context ?? projectLaunchContext();
    if (
        !isAbsolute(context.executionAccountHome) ||
        !context.personalOwner.identity ||
        !["execution-account", "managed-remote"].includes(context.personalOwner.kind)
    )
        throw new Error("Explicit Project owner and execution account home are required");
    if (
        context.personalOwner.kind === "execution-account" &&
        context.personalOwner.identity !== context.executionAccountHome
    )
        throw new Error("Ordinary Project owner must be the execution account");
    return context;
}
function checkIdentityDirectories(home: string, ...segments: string[]): string {
    let path = home;
    for (const segment of segments) {
        path = join(path, segment);
        try {
            const stat = lstatSync(path);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new Error(`Identity storage must be a directory, not a link: ${path}`);
        } catch (error) {
            if (!(error instanceof Error && missing(error))) throw error;
        }
    }
    return path;
}
function recordPath(home: string, id: string): string {
    return join(checkIdentityDirectories(home, ".wld", "projects", requireId(id, "Project ID")), "project.wld.json");
}
function readRecord(path: string, id: string): ProjectRecord | null {
    if (!regularFile(path)) return null;
    const record: ProjectRecord = JSON.parse(readFileSync(path, "utf8"));
    if (
        !record ||
        record.version !== 1 ||
        record.projectId !== id ||
        typeof record.displayName !== "string" ||
        !record.personalOwner ||
        typeof record.personalOwner.identity !== "string" ||
        !Array.isArray(record.repositories)
    )
        throw new Error(`Invalid Project record: ${path}`);
    for (const repository of record.repositories) {
        requireId(repository.repositoryId, "stored repository ID");
        if (
            (repository.remote !== null && typeof repository.remote !== "string") ||
            !["new", "linked"].includes(repository.decision) ||
            !Array.isArray(repository.checkouts)
        )
            throw new Error(`Invalid repository binding: ${path}`);
        for (const checkout of repository.checkouts) {
            requireId(checkout.checkoutId, "stored checkout ID");
            if (typeof checkout.root !== "string") throw new Error(`Invalid checkout binding: ${path}`);
        }
    }
    return record;
}
function candidatesFor(e: IdentityEvidence, context: ProjectLaunchContext): ProjectIdentityCandidate[] {
    if (!e.remote || context.personalOwner.kind === "managed-remote") return [];
    const directory = checkIdentityDirectories(context.executionAccountHome, ".wld", "projects");
    let names: string[];
    try {
        names = readdirSync(directory);
    } catch (error) {
        if (error instanceof Error && missing(error)) return [];
        throw error;
    }
    const candidates: ProjectIdentityCandidate[] = [];
    for (const id of names.filter((name) => uuid.test(name)).sort()) {
        const record = readRecord(recordPath(context.executionAccountHome, id), id);
        if (
            record?.personalOwner.kind === context.personalOwner.kind &&
            record.personalOwner.identity === context.personalOwner.identity &&
            record.repositories.some((repo) => repo.remote === e.remote)
        )
            candidates.push({ projectId: id, displayName: record.displayName, remote: e.remote });
    }
    return candidates;
}
function identity(e: IdentityEvidence, context: ProjectLaunchContext): ProjectIdentity {
    return {
        projectId: e.projectId!,
        repositoryId: e.repositoryId!,
        checkoutId: e.checkoutId!,
        cwd: e.cwd,
        checkoutRoot: e.root,
        ...context,
    };
}
/** Pure lookup, including malformed evidence. Does not probe or create writer locks. */
export function inspectProjectIdentity(path: string, options: ProjectIdentityOptions = {}): ProjectIdentityInspection {
    try {
        const context = contextFor(options);
        const e = evidence(path);
        if (e.projectId) {
            if (context.personalOwner.kind === "execution-account")
                readRecord(recordPath(context.executionAccountHome, e.projectId), e.projectId);
            if (!e.repositoryId || !e.checkoutId) return { kind: "fresh" };
            return { kind: "existing", identity: identity(e, context) };
        }
        const candidates = candidatesFor(e, context);
        return candidates.length ? { kind: "pending", candidates } : { kind: "fresh" };
    } catch (error) {
        return { kind: "invalid", message: String(error) };
    }
}
function writeLocalIdentity(path: string, text: string): void {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
        writeFileSync(fd, text);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(temporary, path);
    syncParentDirectory(path);
}
function putConfig(e: IdentityEvidence, key: string, value: string): void {
    git(e.cwd, ["config", "--file", join(e.common!, "config"), "--no-includes", "--replace-all", key, value]);
}
/** Deliberate entry. Pending and canceled choices never commit identity or an answer. */
export async function admitProjectIdentity(
    path: string,
    options: ProjectIdentityOptions = {},
): Promise<ProjectIdentityAdmission> {
    try {
        const context = contextFor(options);
        let e = evidence(path);
        const candidates = e.projectId ? [] : candidatesFor(e, context);
        if (options.choice?.kind === "cancel") return { kind: "canceled" };
        if (candidates.length && !options.choice) return { kind: "pending", candidates };
        let lockPath: string;
        if (e.common) lockPath = join(e.common, ".runwield-project.lock");
        else {
            const locks = checkIdentityDirectories(context.executionAccountHome, ".wld", "project-identity-locks");
            ensurePrivateDir(locks);
            lockPath = join(locks, `${createHash("sha256").update(e.root).digest("hex")}.lock`);
        }
        regularFile(lockPath);
        const lock = openNativeFileLock(lockPath);
        await lock.lock(true);
        try {
            e = evidence(path);
            const currentCandidates = e.projectId ? [] : candidatesFor(e, context);
            if (!e.projectId && currentCandidates.length && !options.choice)
                return { kind: "pending", candidates: currentCandidates };
            if (
                !e.projectId &&
                options.choice &&
                JSON.stringify(options.choice.candidates) !== JSON.stringify(currentCandidates)
            )
                return { kind: "pending", candidates: currentCandidates };
            const selected =
                options.choice?.kind === "link"
                    ? currentCandidates.find((candidate) => candidate.projectId === options.choice?.projectId)
                    : undefined;
            if (!e.projectId && options.choice?.kind === "link" && !selected)
                return { kind: "invalid", message: "Selected clone-link candidate is no longer available" };
            const needsBinding = !e.projectId || !e.repositoryId || !e.checkoutId || e.marker !== null;
            e.projectId ??= selected?.projectId ?? randomUUID();
            e.repositoryId ??= randomUUID();
            e.checkoutId ??= randomUUID();
            // Validate home evidence before committing repository authority. Managed remote context is only a binding,
            // never permission to write a laptop-owned record through a mount or into the remote account's registry.
            if (context.personalOwner.kind === "execution-account")
                readRecord(recordPath(context.executionAccountHome, e.projectId), e.projectId);
            if (e.common && needsBinding) {
                putConfig(e, "runwield.projectId", e.projectId);
                putConfig(e, "runwield.repositoryId", e.repositoryId);
                const configPath = join(e.common, "config");
                const configFd = openSync(configPath, "r+");
                try {
                    fsyncSync(configFd);
                } finally {
                    closeSync(configFd);
                }
                syncParentDirectory(configPath);
                const checkoutPath = join(e.admin!, "runwield-checkout-id");
                if (!regularFile(checkoutPath)) {
                    writeLocalIdentity(checkoutPath, `${e.checkoutId}\n`);
                }
                const committed = evidence(path);
                if (
                    committed.projectId !== e.projectId ||
                    committed.repositoryId !== e.repositoryId ||
                    committed.checkoutId !== e.checkoutId
                )
                    throw new Error("Git identity verification failed");
                if (e.marker) {
                    unlinkSync(join(e.root, ".wld-project.json"));
                    syncParentDirectory(join(e.root, ".wld-project.json"));
                }
            } else if (!e.common && !e.marker) {
                const marker: IdentityMarker = {
                    format: "runwield-project",
                    version: 1,
                    projectId: e.projectId,
                    repositoryId: e.repositoryId,
                    checkoutId: e.checkoutId,
                };
                writeLocalIdentity(join(e.root, ".wld-project.json"), `${JSON.stringify(marker)}\n`);
            }
            if (context.personalOwner.kind === "execution-account") {
                const file = recordPath(context.executionAccountHome, e.projectId);
                ensurePrivateDir(dirname(file));
                const recordLock = openNativeFileLock(join(dirname(file), "identity.lock"));
                await recordLock.lock(true);
                try {
                    const record = readRecord(file, e.projectId) ?? {
                        version: 1,
                        projectId: e.projectId,
                        displayName: basename(e.root),
                        personalOwner: context.personalOwner,
                        repositories: [],
                    };
                    if (
                        record.personalOwner.kind !== context.personalOwner.kind ||
                        record.personalOwner.identity !== context.personalOwner.identity
                    )
                        throw new Error("Project record belongs to a different personal owner");
                    const before = JSON.stringify(record);
                    let repository = record.repositories.find((repo) => repo.repositoryId === e.repositoryId);
                    if (!repository) {
                        repository = {
                            repositoryId: e.repositoryId,
                            remote: e.remote,
                            decision: selected ? "linked" : "new",
                            checkouts: [],
                        };
                        record.repositories.push(repository);
                    }
                    repository.remote = e.remote;
                    const checkout = repository.checkouts.find((item) => item.checkoutId === e.checkoutId);
                    if (checkout) checkout.root = e.root;
                    else repository.checkouts.push({ checkoutId: e.checkoutId, root: e.root });
                    if (JSON.stringify(record) !== before || !regularFile(file)) writeJsonAtomically(file, record);
                } finally {
                    recordLock.close();
                }
            }
            return { kind: "existing", identity: identity(e, context) };
        } finally {
            lock.close();
        }
    } catch (error) {
        return { kind: "invalid", message: String(error) };
    }
}
export class ProjectIdentityEntryRequired extends Error {
    constructor(readonly result: ProjectIdentityAdmission) {
        super(
            result.kind === "invalid"
                ? result.message
                : result.kind === "pending"
                  ? `Project clone-link choice required: ${result.candidates.map((candidate) => `${candidate.displayName} (${candidate.projectId})`).join(", ")}`
                  : "Project identity entry canceled",
        );
        this.name = "ProjectIdentityEntryRequired";
    }
}
