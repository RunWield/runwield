/** Stable Core identity. Inspection never writes; admission owns all identity mutations. */
import { AsyncLocalStorage } from "node:async_hooks";
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
import { basename, dirname, isAbsolute, join, resolve, relative, sep } from "node:path";
import { getHomeDir } from "@runwield/resources/home";
import {
    remotePersonalResourcesActive,
    remoteProjectOwner,
    type ProjectPersonalOwner,
} from "@runwield/resources/personal";
import {
    ensurePrivateDir,
    openNativeFileLock,
    syncParentDirectory,
    writeJsonAtomically,
    type NativeFileLock,
} from "@runwield/resources/fs";
import {
    listSessionManifestFiles,
    lockPath as sessionLockPath,
    projectPath as sessionProjectPath,
    readSessionProjectEvidence,
    sessionStoragePath,
} from "@runwield/session-files";
import { encodeCwdForSessionDir } from "./directory-key.ts";
import { resolvePrimaryCheckoutRoot } from "./checkout.ts";
import { preferredRegisteredProjectId } from "./legacy-registration-identity.ts";

export type { ProjectPersonalOwner } from "@runwield/resources/personal";

declare const projectIdBrand: unique symbol;

/** Stable identifier persisted by Project admission and home registration. */
export type ProjectId = string & { readonly [projectIdBrand]: true };
interface AccountHomeDirectory {
    device: number;
    inode: number;
}
export interface ProjectLaunchContext {
    personalOwner: ProjectPersonalOwner;
    executionAccountHome: string;
    /** Original account HOME when it resolves through an alias. */
    configuredExecutionAccountHome?: string;
    accountHomeDirectory?: AccountHomeDirectory;
}
export interface ProjectIdentity {
    projectId: ProjectId;
    personalOwner: ProjectPersonalOwner;
    executionAccountHome: string;
    /** Original account HOME when it resolves through an alias. */
    configuredExecutionAccountHome?: string;
    accountHomeDirectory?: AccountHomeDirectory;
    repositoryId: string;
    checkoutId: string;
    cwd: string;
    checkoutRoot: string;
}
export interface ProjectIdentityCandidate {
    projectId: ProjectId;
    displayName: string;
    remote: string;
}
export interface ProjectIdentityPending {
    kind: "pending";
    candidates: ProjectIdentityCandidate[];
}
export interface ProjectIdentityInvalid {
    kind: "invalid";
    cause?: Error;
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
    projectId?: ProjectId;
}
export interface ProjectIdentityOptions {
    context?: ProjectLaunchContext;
    choice?: ProjectCloneChoice;
}
interface IdentityMarker {
    format: "runwield-project";
    version: 1;
    projectId: ProjectId;
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
    historicalRoots?: string[];
}
export interface ProjectStorageLocator {
    repositoryId: string;
    checkoutId: string;
    root: string;
    sessionProjectId: string;
    sessionStoreEstablished: boolean;
    sessionDirectory: string;
    attachedRoot: string;
    attachedDirectory: string;
    /** Verified checkout locations, projected separately from the unchanged storage paths. */
    historicalRoots?: string[];
}
export interface ProjectSessionStorageBinding extends ProjectStorageLocator {
    projectId: ProjectId;
}
interface ProjectRecord {
    version: 1;
    projectId: ProjectId;
    displayName: string;
    personalOwner: ProjectPersonalOwner;
    repositories: RepositoryBinding[];
    storageLocators?: ProjectStorageLocator[];
}
interface IdentityEvidence {
    cwd: string;
    root: string;
    common?: string;
    admin?: string;
    uncommittedPrimaryCheckoutId?: string;
    marker: IdentityMarker | null;
    projectId: ProjectId | null;
    repositoryId: string | null;
    checkoutId: string | null;
    remote: string | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isProjectId(value: string | null | undefined): value is ProjectId {
    return typeof value === "string" && value.length === 36 && uuid.test(value);
}
export function parseProjectId(value: string | null | undefined): ProjectId | undefined {
    return isProjectId(value) ? value : undefined;
}
function requireProjectId(value: string, label: string): ProjectId {
    if (!isProjectId(value)) throw new Error(`Invalid ${label}`);
    return value;
}
function newProjectId(): ProjectId {
    return requireProjectId(randomUUID(), "generated Project ID");
}
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
function git(cwd: string, args: string[], absent = false, input?: Uint8Array): string | null {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 10000, input });
    if (result.error) throw result.error;
    if (result.status === 0) return result.stdout.trim();
    if (absent && result.status === 1) return null;
    throw new Error(`Cannot read Project Git identity: ${result.stderr.trim() || result.status}`);
}
interface GitIdentityConfig {
    projectId: ProjectId | null;
    repositoryId: string | null;
    remote: string | null;
}
// Cache only Git's parsing of exact bytes. Every access still checks the current file,
// checkout binding, launch owner, and home record; no identity decision is retained.
const parsedIdentityConfigs = new Map<string, GitIdentityConfig>();
function identityConfig(cwd: string, file: string): GitIdentityConfig {
    if (!regularFile(file)) throw new Error(`Missing Project Git config: ${file}`);
    const content = readFileSync(file);
    const key = `${process.env.PATH}\0${content.toString("base64")}`;
    const cached = parsedIdentityConfigs.get(key);
    if (cached) return cached;
    const output = git(
        cwd,
        [
            "config",
            "--file",
            "-",
            "--no-includes",
            "--null",
            "--get-regexp",
            "^(runwield\\.(projectid|repositoryid)|remote\\.origin\\.url)$",
        ],
        true,
        content,
    );
    const values = new Map<string, string[]>();
    for (const entry of output?.split("\0") ?? []) {
        if (!entry) continue;
        const delimiter = entry.indexOf("\n");
        const key = delimiter < 0 ? entry : entry.slice(0, delimiter);
        const value = delimiter < 0 ? "" : entry.slice(delimiter + 1).trim();
        const matches = values.get(key) ?? [];
        matches.push(value);
        values.set(key, matches);
    }
    for (const key of ["runwield.projectid", "runwield.repositoryid"]) {
        const matches = values.get(key) ?? [];
        if (matches.length > 1 || matches[0]?.includes("\n"))
            throw new Error(`Multiple values for identity key ${key} in ${file}`);
    }
    const projectId = values.get("runwield.projectid")?.[0];
    const parsed = {
        projectId: projectId === undefined ? null : requireProjectId(projectId, "Git Project ID"),
        repositoryId: values.get("runwield.repositoryid")?.[0] ?? null,
        remote: values.get("remote.origin.url")?.at(-1) ?? null,
    };
    if (parsedIdentityConfigs.size >= 128) parsedIdentityConfigs.clear();
    parsedIdentityConfigs.set(key, parsed);
    return parsed;
}
function parseMarker(contents: string, path: string): IdentityMarker {
    const marker: Omit<IdentityMarker, "projectId"> & { projectId: string } = JSON.parse(contents);
    if (
        !marker ||
        marker.format !== "runwield-project" ||
        marker.version !== 1 ||
        Object.keys(marker).sort().join() !== "checkoutId,format,projectId,repositoryId,version"
    ) {
        throw new Error(`Unrecognized Project marker: ${path}`);
    }
    const projectId = requireProjectId(marker.projectId, `Project ID in ${path}`);
    requireId(marker.repositoryId, `repository ID in ${path}`);
    requireId(marker.checkoutId, `checkout ID in ${path}`);
    return { ...marker, projectId };
}
function markerAt(path: string): IdentityMarker | null {
    return regularFile(path) ? parseMarker(readFileSync(path, "utf8"), path) : null;
}
function checkoutIdAt(admin: string): string | null {
    const path = join(admin, "runwield-checkout-id");
    return regularFile(path) ? requireId(readFileSync(path, "utf8").trim(), "checkout ID") : null;
}
function gitWorktreeRoots(cwd: string): string[] {
    // Git lists the main worktree first. Use NUL separators so paths can contain newlines.
    return git(cwd, ["worktree", "list", "--porcelain", "-z"])!
        .split("\0")
        .filter((record) => record.startsWith("worktree "))
        .map((record) => record.slice(9));
}
function linkedCheckoutIds(common: string): string[] {
    const directory = checkIdentityDirectories(common, "worktrees");
    let entries;
    try {
        entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        if (error instanceof Error && missing(error)) return [];
        throw error;
    }
    return entries.flatMap((entry) => {
        if (!entry.isDirectory()) return [];
        const checkoutId = checkoutIdAt(join(directory, entry.name));
        return checkoutId ? [checkoutId] : [];
    });
}
function registeredRepository(
    context: ProjectLaunchContext,
    projectId: ProjectId,
    repositoryId: string,
): RepositoryBinding | undefined {
    if (context.personalOwner.kind !== "execution-account") return undefined;
    const record = readRecord(recordPath(context.executionAccountHome, projectId), projectId);
    if (
        record?.personalOwner.kind !== context.personalOwner.kind ||
        record.personalOwner.identity !== context.personalOwner.identity
    )
        return undefined;
    return record.repositories.find((entry) => entry.repositoryId === repositoryId);
}
function committedWorktreeMarker(root: string, common: string): IdentityMarker | null {
    const markerPath = join(root, ".wld-project.json");
    const gitPath = join(root, ".git");
    if (
        !lstatSync(markerPath, { throwIfNoEntry: false })?.isFile() ||
        !lstatSync(gitPath, { throwIfNoEntry: false })?.isFile()
    )
        return null;
    const admin = realpathSync(git(root, ["rev-parse", "--resolve-git-dir", gitPath])!);
    if (dirname(admin) !== join(common, "worktrees")) return null;
    const gitDir = ["--git-dir", admin];
    const gitCommon = git(root, [...gitDir, "rev-parse", "--git-common-dir"])!;
    if (realpathSync(resolve(root, gitCommon)) !== common) return null;
    const head = git(root, [...gitDir, "rev-parse", "--verify", "-q", "HEAD"], true);
    if (!head) return null;
    const tree = git(root, [...gitDir, "ls-tree", head, "--", ".wld-project.json"]);
    const blob = tree?.match(/^100(644|755) blob ([a-f0-9]+)\t\.wld-project\.json$/)?.[2];
    if (!blob) return null;
    const contents = readFileSync(markerPath);
    const hashArgs = [...gitDir, "hash-object", "--no-filters", "--stdin"];
    if (git(root, hashArgs, false, contents) !== blob) {
        // Git can check out an LF blob as CRLF. Verify that exact conversion without running filters.
        const checkout = contents.toString("latin1");
        const normalized = checkout.replaceAll("\r\n", "\n");
        if (
            normalized === checkout ||
            normalized.includes("\r") ||
            normalized.replaceAll("\n", "\r\n") !== checkout ||
            git(root, hashArgs, false, Buffer.from(normalized, "latin1")) !== blob
        )
            return null;
    }
    try {
        return parseMarker(contents.toString("utf8"), markerPath);
    } catch {
        // An unrelated worktree may track its own file at this name.
        return null;
    }
}
function recoverPrimaryMarker(
    roots: string[],
    common: string,
    primaryRoot: string,
    context: ProjectLaunchContext,
): IdentityMarker | null {
    if (context.personalOwner.kind !== "execution-account") return null;
    let recovered: IdentityMarker | null = null;
    for (const root of roots) {
        const marker = committedWorktreeMarker(root, common);
        if (!marker) continue;
        const repository = registeredRepository(context, marker.projectId, marker.repositoryId);
        if (
            !repository?.checkouts.some((entry) => entry.root === primaryRoot && entry.checkoutId === marker.checkoutId)
        )
            continue;
        if (
            recovered &&
            (marker.projectId !== recovered.projectId ||
                marker.repositoryId !== recovered.repositoryId ||
                marker.checkoutId !== recovered.checkoutId)
        )
            throw new Error(
                "Linked worktree markers match different registered primary identities; all were preserved",
            );
        recovered = marker;
    }
    return recovered;
}
function hasGitDirectory(path: string): boolean {
    if (process.env.GIT_DIR || process.env.GIT_COMMON_DIR || process.env.GIT_WORK_TREE) return true;
    for (let ancestor = path; ; ancestor = dirname(ancestor)) {
        for (const name of [".git", "HEAD"]) {
            try {
                // HEAD also keeps bare repositories on Git's authoritative probe path.
                lstatSync(join(ancestor, name));
                return true;
            } catch (error) {
                if (!(error instanceof Error && missing(error))) throw error;
            }
        }
        if (dirname(ancestor) === ancestor) return false;
    }
}
function evidence(path: string, context: ProjectLaunchContext): IdentityEvidence {
    const cwd = realpathSync(path);
    if (!lstatSync(cwd).isDirectory()) throw new Error("Project root must be a directory");
    // A non-repository exit is distinguished from other Git failures by filesystem evidence.
    const probe = hasGitDirectory(cwd)
        ? spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--git-common-dir", "--git-dir"], {
              encoding: "utf8",
              timeout: 10000,
          })
        : { status: 1, stdout: "", stderr: "not a git repository", error: undefined };
    if (probe.error) throw probe.error;
    if (probe.status !== 0 && !probe.stderr.includes("not a git repository"))
        throw new Error(`Cannot inspect Project Git directory: ${probe.stderr}`);
    const directories = probe.stdout.trim().split("\n");
    // Newlines in a checkout path make the combined response ambiguous; ask each path separately then.
    const combined = probe.status === 0 && directories.length === 3;
    let root =
        probe.status === 0
            ? realpathSync(combined ? directories[0] : git(cwd, ["rev-parse", "--show-toplevel"])!)
            : cwd;
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
    const common = realpathSync(resolve(cwd, combined ? directories[1] : git(cwd, ["rev-parse", "--git-common-dir"])!));
    const admin = realpathSync(resolve(cwd, combined ? directories[2] : git(cwd, ["rev-parse", "--git-dir"])!));
    const file = join(common, "config");
    const { projectId, repositoryId, remote } = identityConfig(cwd, file);
    const checkoutId = checkoutIdAt(admin);
    if (repositoryId !== null) requireId(repositoryId, "Git repository ID");
    if (!projectId && repositoryId) throw new Error("Git repository binding has no Project ID");
    const linked = admin !== common;
    const primaryCheckoutId = linked ? checkoutIdAt(common) : checkoutId;
    // A Git worktree can contain a committed copy of the marker from before Git adoption.
    // Its Project and repository IDs are shared. The marker's checkout ID belongs to the primary.
    const needsPrimaryRoot = linked && (marker || !primaryCheckoutId || !projectId || !repositoryId);
    const needsSiblingMarkers =
        !linked &&
        !primaryCheckoutId &&
        !marker &&
        lstatSync(join(common, "worktrees"), { throwIfNoEntry: false })?.isDirectory();
    const [listedPrimary, ...siblings] = needsPrimaryRoot || needsSiblingMarkers ? gitWorktreeRoots(cwd) : [];
    if (needsPrimaryRoot && !listedPrimary) throw new Error("Cannot find the primary Git worktree");
    const primaryRoot = needsPrimaryRoot ? realpathSync(listedPrimary) : root;
    const localPrimaryMarker = !linked
        ? marker
        : needsPrimaryRoot
          ? markerAt(join(primaryRoot, ".wld-project.json"))
          : null;
    const primaryMarker =
        localPrimaryMarker ??
        (!primaryCheckoutId ? recoverPrimaryMarker(siblings, common, primaryRoot, context) : null);
    if (
        primaryMarker &&
        ((projectId && projectId !== primaryMarker.projectId) ||
            (repositoryId && repositoryId !== primaryMarker.repositoryId) ||
            (primaryCheckoutId && primaryCheckoutId !== primaryMarker.checkoutId))
    )
        throw new Error("Project marker conflicts with Git identity; both were preserved");
    const knownPrimaryCheckoutId = primaryCheckoutId ?? primaryMarker?.checkoutId;
    const linkedIds = linkedCheckoutIds(common);
    // An older admission could remove the linked marker and claim the primary ID in the registry.
    // A saved primary root can identify that conflict, but cannot authorize a Git binding.
    const savedRepository =
        !knownPrimaryCheckoutId && projectId && repositoryId
            ? registeredRepository(context, projectId, repositoryId)
            : undefined;
    const possiblePrimaryIds = knownPrimaryCheckoutId
        ? [knownPrimaryCheckoutId]
        : (savedRepository?.checkouts
              .filter((entry) => entry.root === primaryRoot || entry.historicalRoots?.includes(primaryRoot))
              .map((entry) => entry.checkoutId) ?? []);
    if (possiblePrimaryIds.some((id) => linkedIds.includes(id)))
        throw new Error("Linked checkout shares the primary Git checkout ID; both bindings were preserved");
    if (new Set(linkedIds).size !== linkedIds.length)
        throw new Error("Linked checkouts share a Git checkout ID; both bindings were preserved");
    if (
        linked &&
        marker &&
        (marker.projectId !== (projectId ?? primaryMarker?.projectId) ||
            marker.repositoryId !== (repositoryId ?? primaryMarker?.repositoryId) ||
            marker.checkoutId !== (primaryCheckoutId ?? primaryMarker?.checkoutId))
    )
        throw new Error("Linked checkout marker conflicts with the primary Project identity; both were preserved");
    return {
        cwd,
        root,
        common,
        admin,
        marker,
        uncommittedPrimaryCheckoutId: !primaryCheckoutId ? primaryMarker?.checkoutId : undefined,
        projectId: projectId ?? primaryMarker?.projectId ?? null,
        repositoryId: repositoryId ?? primaryMarker?.repositoryId ?? null,
        checkoutId: checkoutId ?? (linked ? null : (primaryMarker?.checkoutId ?? null)),
        remote,
    };
}
const trustedLaunchContext = new AsyncLocalStorage<ProjectLaunchContext>();
/** Private runtime entry supplies verified launcher ownership without changing process-global resources. */
export async function withProjectLaunchContext<T>(context: ProjectLaunchContext, run: () => Promise<T>): Promise<T> {
    return await trustedLaunchContext.run(context, run);
}
export function scopedProjectExecutionAccountHome(): string | undefined {
    return trustedLaunchContext.getStore()?.executionAccountHome;
}
export function projectLaunchContext(): ProjectLaunchContext {
    const trusted = trustedLaunchContext.getStore();
    if (trusted) return trusted;
    const executionAccountHome = getHomeDir();
    return {
        executionAccountHome,
        personalOwner: remoteProjectOwner() ?? { kind: "execution-account", identity: executionAccountHome },
    };
}
/** Keep writes on the captured account directory if the login HOME is retargeted during an operation. */
export function verifyExecutionAccountHome(
    context: Pick<
        ProjectLaunchContext,
        "configuredExecutionAccountHome" | "executionAccountHome" | "accountHomeDirectory"
    >,
): void {
    if (!context.accountHomeDirectory && !context.configuredExecutionAccountHome) return;
    const resolved = realpathSync(context.configuredExecutionAccountHome ?? context.executionAccountHome);
    const target = lstatSync(resolved);
    if (
        resolved !== context.executionAccountHome ||
        (context.accountHomeDirectory &&
            (target.dev !== context.accountHomeDirectory.device || target.ino !== context.accountHomeDirectory.inode))
    ) {
        throw new Error("The execution account home changed during this operation.");
    }
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
    verifyExecutionAccountHome(context);
    if (context.accountHomeDirectory) return context;
    // On macOS /var is a system-wide alias that also appears in existing test and Project locators.
    const configured = lstatSync(context.executionAccountHome, { throwIfNoEntry: false });
    if (!configured || (process.platform !== "linux" && !configured.isSymbolicLink())) return context;
    const physical = realpathSync(context.executionAccountHome);
    const target = lstatSync(physical);
    if (!target.isDirectory() || (process.geteuid && target.uid !== process.geteuid()))
        throw new Error("The account home must resolve to a directory owned by the effective user.");
    return {
        ...context,
        ...(physical !== context.executionAccountHome && {
            configuredExecutionAccountHome: context.executionAccountHome,
        }),
        accountHomeDirectory: { device: target.dev, inode: target.ino },
        executionAccountHome: physical,
        personalOwner:
            context.personalOwner.kind === "execution-account"
                ? { ...context.personalOwner, identity: physical }
                : context.personalOwner,
    };
}
/** Resolve and validate the account scope selected by the current launch. */
export function resolveProjectLaunchContext(): ProjectLaunchContext {
    return contextFor({});
}

/** Normalize the configured account-home prefix without following redirects inside its storage. */
export function executionAccountStoragePath(path: string, context = contextFor({})): string {
    const absolute = resolve(path);
    const alias = context.configuredExecutionAccountHome;
    if (alias) {
        const suffix = relative(alias, absolute);
        if (suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix))
            return join(context.executionAccountHome, suffix);
    }
    // A saved Session locator may use another spelling of this same login home.
    const marker = sep + ".wld" + sep + "sessions";
    const index = absolute.indexOf(marker);
    if (index > 0 && (absolute.length === index + marker.length || absolute[index + marker.length] === sep)) {
        const prefix = absolute.slice(0, index);
        if (
            prefix !== context.executionAccountHome &&
            lstatSync(prefix, { throwIfNoEntry: false })?.isSymbolicLink() &&
            realpathSync(prefix) === realpathSync(context.executionAccountHome)
        )
            return join(context.executionAccountHome, absolute.slice(index + 1));
    }
    return absolute;
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
function recordPath(home: string, id: ProjectId): string {
    return join(
        checkIdentityDirectories(home, ".wld", "projects", requireProjectId(id, "Project ID")),
        "project.wld.json",
    );
}
function readRecord(path: string, id: ProjectId): ProjectRecord | null {
    if (!regularFile(path)) return null;
    const record: Omit<ProjectRecord, "projectId"> & { projectId: string } = JSON.parse(readFileSync(path, "utf8"));
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
            if (
                checkout.historicalRoots &&
                (!Array.isArray(checkout.historicalRoots) ||
                    checkout.historicalRoots.some((root) => typeof root !== "string" || !isAbsolute(root)))
            )
                throw new Error(`Invalid historical checkout binding: ${path}`);
        }
    }
    for (const locator of record.storageLocators ?? []) {
        const repository = record.repositories.find((item) => item.repositoryId === locator.repositoryId);
        if (
            !repository?.checkouts.some((item) => item.checkoutId === locator.checkoutId) ||
            !isAbsolute(locator.root) ||
            !locator.sessionProjectId ||
            locator.sessionDirectory !==
                join(dirname(dirname(dirname(path))), "sessions", encodeCwdForSessionDir(locator.root)) ||
            !isAbsolute(locator.attachedRoot) ||
            locator.attachedDirectory !==
                join(
                    dirname(dirname(dirname(path))),
                    "attached",
                    encodeCwdForSessionDir(locator.attachedRoot),
                    "workflows",
                )
        )
            throw new Error(`Invalid Project storage locator: ${path}`);
    }
    return { ...record, projectId: id };
}
/** Read only committed bindings for this owner and this admitted repository/checkout. */
export function inspectProjectStorage(
    path: string,
    options: ProjectIdentityOptions = {},
): ProjectSessionStorageBinding[] {
    const context = contextFor(options);
    if (context.personalOwner.kind !== "execution-account") return [];
    let e: IdentityEvidence;
    try {
        e = evidence(path, context);
    } catch (error) {
        if (error instanceof Error && missing(error)) return [];
        throw error;
    }
    if (!e.projectId || !e.repositoryId || !e.checkoutId) return [];
    const record = readRecord(recordPath(context.executionAccountHome, e.projectId), e.projectId);
    if (
        !record ||
        record.personalOwner.kind !== context.personalOwner.kind ||
        record.personalOwner.identity !== context.personalOwner.identity
    )
        return [];
    const repository = record.repositories.find((item) => item.repositoryId === e.repositoryId);
    // The committed checkout ID verifies a move without making a passive read rewrite its saved root.
    if (!repository?.checkouts.some((item) => item.checkoutId === e.checkoutId)) return [];
    return (record.storageLocators ?? [])
        .toSorted(
            (a, b) =>
                Number(b.checkoutId === e.checkoutId && b.repositoryId === e.repositoryId) -
                Number(a.checkoutId === e.checkoutId && a.repositoryId === e.repositoryId),
        )
        .map((locator) => {
            const checkout = record.repositories
                .find((item) => item.repositoryId === locator.repositoryId)!
                .checkouts.find((item) => item.checkoutId === locator.checkoutId)!;
            return {
                ...locator,
                projectId: record.projectId,
                historicalRoots: [
                    ...new Set([
                        locator.root,
                        locator.attachedRoot,
                        checkout.root,
                        ...(locator.repositoryId === e.repositoryId && locator.checkoutId === e.checkoutId
                            ? [e.root]
                            : []),
                        ...(checkout.historicalRoots ?? []),
                    ]),
                ],
            };
        });
}

/** Return this owner's current registered checkout root first, followed by distinct prior roots. */
export function inspectProjectCheckoutRoots(identity: ProjectIdentity): string[] {
    if (identity.personalOwner.kind !== "execution-account") return [];
    const record = readRecord(recordPath(identity.executionAccountHome, identity.projectId), identity.projectId);
    if (record?.personalOwner.identity !== identity.personalOwner.identity) return [];
    const checkout = record.repositories
        .find((repository) => repository.repositoryId === identity.repositoryId)
        ?.checkouts.find((entry) => entry.checkoutId === identity.checkoutId);
    return checkout ? [...new Set([checkout.root, ...(checkout.historicalRoots ?? [])])] : [];
}

/** A historical path can carry private data for a different admitted Project. */
export function isOtherProjectCheckoutRoot(identity: ProjectIdentity, root: string): boolean {
    if (identity.personalOwner.kind !== "execution-account") return false;
    const directory = checkIdentityDirectories(identity.executionAccountHome, ".wld", "projects");
    let names: string[];
    try {
        names = readdirSync(directory);
    } catch (error) {
        if (error instanceof Error && missing(error)) return false;
        throw error;
    }
    for (const id of names.filter(isProjectId)) {
        if (id === identity.projectId) continue;
        const record = readRecord(recordPath(identity.executionAccountHome, id), id);
        if (
            record?.personalOwner.identity === identity.personalOwner.identity &&
            record.repositories.some((repository) =>
                repository.checkouts.some(
                    (checkout) => checkout.root === root || checkout.historicalRoots?.includes(root),
                ),
            )
        )
            return true;
    }
    return false;
}

/** Committed Session directories remain owned by their Project when a checkout is offline or moved. */
export function inspectSessionStorageBindings(): ProjectSessionStorageBinding[] {
    const bindings: ProjectSessionStorageBinding[] = [];
    for (const record of readOwnedProjectRecords()) {
        for (const locator of record.storageLocators ?? []) {
            bindings.push({ ...locator, projectId: record.projectId });
        }
    }
    return bindings;
}

function readOwnedProjectRecords(): ProjectRecord[] {
    // Managed Sessions carry their own bindings and never scan the execution account's local registry.
    const launch = trustedLaunchContext.getStore();
    if (launch ? launch.personalOwner.kind === "managed-remote" : remotePersonalResourcesActive()) return [];
    const context = contextFor({});
    const directory = checkIdentityDirectories(context.executionAccountHome, ".wld", "projects");
    let names: string[];
    try {
        names = readdirSync(directory);
    } catch (error) {
        if (error instanceof Error && missing(error)) return [];
        throw error;
    }
    return names.filter(isProjectId).flatMap((id) => {
        const record = readRecord(recordPath(context.executionAccountHome, id), id);
        return record &&
            record.personalOwner.kind === context.personalOwner.kind &&
            record.personalOwner.identity === context.personalOwner.identity
            ? [record]
            : [];
    });
}

/** Current checkout roots require matching repository and checkout authority. */
export function inspectSessionProjectRoots(sessionProjectId: string): string[] {
    const roots: string[] = [];
    for (const record of readOwnedProjectRecords()) {
        if (
            record.projectId !== sessionProjectId &&
            !record.storageLocators?.some((item) => item.sessionProjectId === sessionProjectId)
        )
            continue;
        for (const repository of record.repositories)
            for (const checkout of repository.checkouts) {
                try {
                    const bindings = inspectProjectStorage(checkout.root);
                    if (
                        bindings.some(
                            (item) =>
                                item.projectId === record.projectId &&
                                item.repositoryId === repository.repositoryId &&
                                item.checkoutId === checkout.checkoutId,
                        )
                    )
                        roots.push(checkout.root);
                } catch {
                    /* Missing and retargeted checkouts grant no current-root authority. */
                }
            }
    }
    return [...new Set(roots)];
}

/** Publish that an admitted locator now has a store before any Session is created there. */
export function establishProjectSessionStorage(root: string, sessionProjectId: string, directory: string): void {
    const context = contextFor({});
    if (context.personalOwner.kind !== "execution-account") return;
    directory = executionAccountStoragePath(directory, context);
    const e = evidence(root, context);
    if (!e.projectId) return;
    const path = recordPath(context.executionAccountHome, e.projectId);
    const before = readRecord(path, e.projectId);
    const locator = before?.storageLocators?.find(
        (item) =>
            (item.sessionProjectId === sessionProjectId || e.projectId === sessionProjectId) &&
            item.sessionDirectory === directory,
    );
    if (!locator || locator.sessionStoreEstablished) return;
    const lock = openNativeFileLock(join(dirname(path), "identity.lock"));
    try {
        lock.lockSync(true);
        const record = readRecord(path, e.projectId);
        const saved = record?.storageLocators?.find(
            (item) =>
                (item.sessionProjectId === sessionProjectId || e.projectId === sessionProjectId) &&
                item.sessionDirectory === directory,
        );
        if (!record || !saved) throw new Error("Project storage binding changed during Session creation");
        verifyExecutionAccountHome(context);
        saved.sessionStoreEstablished = true;
        writeJsonAtomically(path, record);
    } finally {
        lock.close();
    }
}

/** A path claimed by another admitted Project cannot authorize legacy storage access. */
export function isProjectStorageRootClaimed(root: string, options: ProjectIdentityOptions = {}): boolean {
    const context = contextFor(options);
    try {
        realpathSync(root);
    } catch (error) {
        if (error instanceof Error && missing(error)) return false;
        throw error;
    }
    if (context.personalOwner.kind !== "execution-account") return false;
    const directory = checkIdentityDirectories(context.executionAccountHome, ".wld", "projects");
    let names: string[];
    try {
        names = readdirSync(directory);
    } catch (error) {
        if (error instanceof Error && missing(error)) return false;
        throw error;
    }
    const current = evidence(root, context);
    for (const id of names.filter(isProjectId)) {
        const record = readRecord(recordPath(context.executionAccountHome, id), id);
        // Git worktrees share repository authority before every checkout has been admitted.
        if (id === current.projectId && record?.repositories.some((item) => item.repositoryId === current.repositoryId))
            continue;
        if (
            record?.personalOwner.kind === context.personalOwner.kind &&
            record.personalOwner.identity === context.personalOwner.identity &&
            record.storageLocators?.some((item) => item.root === root || item.attachedRoot === root)
        )
            return true;
    }
    return false;
}

export function assertUnclaimedSessionRoot(root: string, options: ProjectIdentityOptions = {}): void {
    if (isProjectStorageRootClaimed(root, options))
        throw new Error("Session storage belongs to another Project identity");
}

function storageLocator(e: IdentityEvidence, home: string, root: string): ProjectStorageLocator {
    assertUnclaimedSessionRoot(root, {
        context: { executionAccountHome: home, personalOwner: { kind: "execution-account", identity: home } },
    });
    const sessionDirectory = checkIdentityDirectories(home, ".wld", "sessions", encodeCwdForSessionDir(root));
    const file = sessionProjectPath(sessionDirectory);
    const sessionStoreEstablished = regularFile(file);
    let sessionProjectId: string = e.projectId!;
    if (sessionStoreEstablished) {
        const project = readSessionProjectEvidence(file);
        if (!project || project.remote || !project.projectId || project.currentRoot !== root)
            throw new Error(`Legacy Session locator does not match recorded checkout: ${file}`);
        sessionProjectId = project.projectId;
    }
    return {
        repositoryId: e.repositoryId!,
        checkoutId: e.checkoutId!,
        root,
        sessionProjectId,
        sessionDirectory,
        sessionStoreEstablished,
        attachedRoot: resolvePrimaryCheckoutRoot(root),
        attachedDirectory: join(
            home,
            ".wld",
            "attached",
            encodeCwdForSessionDir(resolvePrimaryCheckoutRoot(root)),
            "workflows",
        ),
    };
}

class SessionStorageBusy extends Error {
    constructor(readonly lockPath: string) {
        super("Session storage is settling");
    }
}

/** Try sorted original writer locks, then take the identity record lock. Contention unwinds
 * checkout admission before waiting, because an in-flight Session can itself enter Project runtime.
 * No native lock file is replaced or relocated.
 */
function settleStorageLocators(locators: ProjectStorageLocator[], projectId: ProjectId): NativeFileLock[] {
    const paths = [
        ...new Set(
            locators.flatMap((locator) =>
                listSessionManifestFiles(locator.sessionDirectory, true)
                    // A successor transcript carries its original Project's recovery descriptor.
                    // It does not create another bundle or writer lock in this checkout's store.
                    .filter(
                        (item) =>
                            (item.projectId === locator.sessionProjectId || item.projectId === projectId) &&
                            (item.hasPrimaryManifest ||
                                (item.originalTranscriptPath !== undefined &&
                                    dirname(
                                        sessionStoragePath(item.originalTranscriptPath, locator.sessionDirectory),
                                    ) === locator.sessionDirectory)),
                    )
                    .map((item) => sessionLockPath(locator.sessionDirectory, item.runwieldSessionId)),
            ),
        ),
    ].sort();
    const locks: NativeFileLock[] = [];
    try {
        for (const path of paths) {
            const lock = openNativeFileLock(path);
            locks.push(lock);
            if (!lock.tryLockSync(true)) throw new SessionStorageBusy(path);
        }
        return locks;
    } catch (error) {
        for (const lock of locks.reverse()) lock.close();
        throw error;
    }
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
    for (const id of names.filter(isProjectId).sort()) {
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
        const e = evidence(path, context);
        if (e.projectId) {
            if (context.personalOwner.kind === "execution-account")
                readRecord(recordPath(context.executionAccountHome, e.projectId), e.projectId);
            if (!e.repositoryId || !e.checkoutId) return { kind: "fresh" };
            return { kind: "existing", identity: identity(e, context) };
        }
        const candidates = candidatesFor(e, context);
        return candidates.length ? { kind: "pending", candidates } : { kind: "fresh" };
    } catch (error) {
        return { kind: "invalid", message: String(error), ...(error instanceof Error && { cause: error }) };
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
interface RegistrationIdentityBinding {
    kind: "existing" | "legacy";
    projectId: ProjectId;
}

/** Core owns the binding procedure. Both entry modes acquire the same locks in the same order. */
function* projectAdmission(
    path: string,
    options: ProjectIdentityOptions,
    binding?: RegistrationIdentityBinding,
): Generator<NativeFileLock, ProjectIdentityAdmission, void> {
    try {
        const context = contextFor(options);
        let e = evidence(path, context);
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
        try {
            yield lock;
            e = evidence(path, context);
            if (
                e.projectId &&
                ((options.choice?.kind === "link" && options.choice.projectId !== e.projectId) ||
                    (options.choice?.kind === "new" &&
                        options.choice.candidates.some((candidate) => candidate.projectId === e.projectId)))
            )
                return {
                    kind: "invalid",
                    message: `Clone choice conflicts with the committed Project ${e.projectId}; identity was preserved`,
                };
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
            if (binding && (e.projectId ?? selected?.projectId ?? binding.projectId) !== binding.projectId)
                return {
                    kind: "invalid",
                    message: "The destination belongs to another Project; its identity was preserved",
                };
            if (binding?.kind === "existing" && !e.projectId && !selected)
                return {
                    kind: "invalid",
                    message: "The destination has no evidence of the registered Project identity",
                };
            const needsBinding =
                !e.projectId ||
                !e.repositoryId ||
                !e.checkoutId ||
                e.marker !== null ||
                e.uncommittedPrimaryCheckoutId !== undefined;
            e.projectId ??=
                selected?.projectId ??
                binding?.projectId ??
                preferredRegisteredProjectId(e.root, context) ??
                newProjectId();
            requireProjectId(e.projectId, "Project ID");
            e.repositoryId ??= randomUUID();
            e.checkoutId ??= randomUUID();
            // Validate home evidence before committing repository authority. Managed remote context is only a binding,
            // never permission to write a laptop-owned record through a mount or into the remote account's registry.
            if (context.personalOwner.kind === "execution-account") {
                const record = readRecord(recordPath(context.executionAccountHome, e.projectId), e.projectId);
                if (
                    record &&
                    (record.personalOwner.kind !== context.personalOwner.kind ||
                        record.personalOwner.identity !== context.personalOwner.identity)
                )
                    throw new Error("Project record belongs to a different personal owner");
            }
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
                if (e.uncommittedPrimaryCheckoutId)
                    writeLocalIdentity(join(e.common, "runwield-checkout-id"), `${e.uncommittedPrimaryCheckoutId}\n`);
                const checkoutPath = join(e.admin!, "runwield-checkout-id");
                if (!regularFile(checkoutPath)) {
                    writeLocalIdentity(checkoutPath, `${e.checkoutId}\n`);
                }
                const committed = evidence(path, context);
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
                const previousRecord = readRecord(file, e.projectId);
                const previousCheckout = previousRecord?.repositories
                    .find((repo) => repo.repositoryId === e.repositoryId)
                    ?.checkouts.find((item) => item.checkoutId === e.checkoutId);
                const previousLocators = previousRecord?.storageLocators ?? [];
                const ownLocators = previousLocators.filter(
                    (item) => item.repositoryId === e.repositoryId && item.checkoutId === e.checkoutId,
                );
                const additions = ownLocators.length
                    ? ownLocators
                          .filter(
                              (item) =>
                                  !item.sessionStoreEstablished &&
                                  regularFile(sessionProjectPath(item.sessionDirectory)),
                          )
                          .map((item) => ({ ...item, sessionStoreEstablished: true }))
                    : [storageLocator(e, context.executionAccountHome, previousCheckout?.root ?? e.root)];
                if (previousCheckout && previousCheckout.root !== e.root && !ownLocators.length) {
                    const current = storageLocator(e, context.executionAccountHome, e.root);
                    if (regularFile(sessionProjectPath(current.sessionDirectory))) additions.push(current);
                }
                // A new worktree does not change an existing checkout's binding. Its caller may
                // already own that checkout's Session writer while preparing the worktree.
                const affectedLocators = [
                    ...additions,
                    ...(previousCheckout && previousCheckout.root !== e.root ? ownLocators : []),
                    ...(selected ? previousLocators : []),
                ];
                const settledLocks = settleStorageLocators(affectedLocators, e.projectId);
                const recordLock = openNativeFileLock(join(dirname(file), "identity.lock"));
                try {
                    yield recordLock;
                    const verified = evidence(path, context);
                    if (
                        verified.projectId !== e.projectId ||
                        verified.repositoryId !== e.repositoryId ||
                        verified.checkoutId !== e.checkoutId ||
                        verified.root !== e.root
                    )
                        throw new Error("Project identity changed during storage admission; retry entry");
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
                            decision: selected || previousRecord ? "linked" : "new",
                            checkouts: [],
                        };
                        record.repositories.push(repository);
                    }
                    record.storageLocators ??= [];
                    for (const locator of additions) {
                        const index = record.storageLocators.findIndex(
                            (item) =>
                                item.sessionDirectory === locator.sessionDirectory &&
                                item.repositoryId === locator.repositoryId,
                        );
                        if (index < 0) record.storageLocators.push(locator);
                        else record.storageLocators[index] = locator;
                    }
                    repository.remote = e.remote;
                    const checkout = repository.checkouts.find((item) => item.checkoutId === e.checkoutId);
                    if (checkout) {
                        if (checkout.root !== e.root)
                            checkout.historicalRoots = [
                                ...new Set([...(checkout.historicalRoots ?? []), checkout.root]),
                            ];
                        checkout.root = e.root;
                    } else repository.checkouts.push({ checkoutId: e.checkoutId, root: e.root });
                    if (JSON.stringify(record) !== before || !regularFile(file)) writeJsonAtomically(file, record);
                } finally {
                    recordLock.close();
                    for (const held of settledLocks.reverse()) held.close();
                }
            }
            return { kind: "existing", identity: identity(e, context) };
        } finally {
            lock.close();
        }
    } catch (error) {
        if (error instanceof SessionStorageBusy) {
            // All identity locks have been released by this point. Wait only on the original writer.
            const writer = openNativeFileLock(error.lockPath, false);
            try {
                yield writer;
            } finally {
                writer.close();
            }
            return yield* projectAdmission(path, options, binding);
        }
        return { kind: "invalid", message: String(error), ...(error instanceof Error && { cause: error }) };
    }
}
/** Deliberate entry. Contended writers release locks before waiting for another Session. */
export async function admitProjectIdentity(
    path: string,
    options: ProjectIdentityOptions = {},
): Promise<ProjectIdentityAdmission> {
    const admission = projectAdmission(path, options);
    let step = admission.next();
    while (!step.done) {
        try {
            if (!step.value.tryLockSync(true)) await step.value.lock(true);
        } catch (error) {
            step = admission.throw(error);
            continue;
        }
        step = admission.next();
    }
    return step.value;
}

function admitImmediately(
    path: string,
    options: ProjectIdentityOptions,
    binding?: RegistrationIdentityBinding,
): ProjectIdentityAdmission {
    const admission = projectAdmission(path, options, binding);
    let step = admission.next();
    while (!step.done) {
        try {
            if (!step.value.tryLockSync(true))
                throw new Error("Project identity is busy; retry after the current writer finishes.");
        } catch (error) {
            step = admission.throw(error);
            continue;
        }
        step = admission.next();
    }
    return step.value;
}

/** Registration can retain a historical ID only after its registry has verified the binding. */
export function admitRegistrationIdentity(
    path: string,
    context: ProjectLaunchContext,
    binding?: RegistrationIdentityBinding,
    choice?: ProjectCloneChoice,
): ProjectIdentityAdmission {
    return admitImmediately(path, { context, choice }, binding);
}

/** Synchronous storage entry cannot wait on a writer that needs the calling event loop. */
export function admitProjectForStorage(path: string, options: ProjectIdentityOptions = {}): ProjectIdentity {
    const result = admitImmediately(path, options);
    if (result.kind !== "existing") throw new ProjectIdentityEntryRequired(result);
    return result.identity;
}

export class ProjectIdentityEntryRequired extends Error {
    constructor(readonly result: ProjectIdentityAdmission) {
        super(
            result.kind === "invalid"
                ? result.message
                : result.kind === "pending"
                  ? `Project clone-link choice required: ${result.candidates.map((candidate) => `${candidate.displayName} (${candidate.projectId})`).join(", ")}`
                  : "Project identity entry canceled",
            result.kind === "invalid" && result.cause ? { cause: result.cause } : undefined,
        );
        this.name = "ProjectIdentityEntryRequired";
    }
}

/** Trusted laptop registration has repository identity but no source checkout. */
export interface HomeProjectOwner {
    kind: "home-project";
    projectId: ProjectId;
    repositoryId: string;
    personalOwner: ProjectPersonalOwner;
    executionAccountHome: string;
    /** Original account HOME when it resolves through an alias. */
    configuredExecutionAccountHome?: string;
    accountHomeDirectory?: AccountHomeDirectory;
    registrationDigest: string;
}
export type ProjectStoreIdentity = ProjectIdentity | HomeProjectOwner;
export interface HomeProjectRegistration {
    projectId: ProjectId;
    repositoryId: string;
    displayName: string;
}
const homeProjectOwners = new AsyncLocalStorage<HomeProjectOwner>();
export function currentHomeProjectOwner(): HomeProjectOwner | undefined {
    return homeProjectOwners.getStore();
}
export function isHomeProjectOwner(identity: ProjectStoreIdentity): identity is HomeProjectOwner {
    return "kind" in identity && identity.kind === "home-project";
}
export function projectStoreLocation(identity: ProjectStoreIdentity): string {
    return isHomeProjectOwner(identity)
        ? join(identity.executionAccountHome, ".wld", "projects", identity.projectId)
        : identity.checkoutRoot;
}
export function findHomeProjectOwner(projectId: ProjectId, repositoryId: string): HomeProjectOwner | null {
    const context = contextFor({});
    const record = readRecord(recordPath(context.executionAccountHome, projectId), projectId);
    if (!record || !record.repositories.some((entry) => entry.repositoryId === repositoryId)) return null;
    return inspectHomeProjectOwner(projectId, repositoryId);
}
export function inspectHomeProjectOwner(projectId: ProjectId, repositoryId: string): HomeProjectOwner {
    requireId(repositoryId, "repository ID");
    const context = contextFor({});
    if (context.personalOwner.kind !== "execution-account") throw new Error("Home store belongs to this account only.");
    const record = readRecord(recordPath(context.executionAccountHome, projectId), projectId);
    if (
        !record ||
        record.personalOwner.kind !== context.personalOwner.kind ||
        record.personalOwner.identity !== context.personalOwner.identity
    )
        throw new Error("Home Project owner is unavailable.");
    const repository = record.repositories.find((entry) => entry.repositoryId === repositoryId);
    if (!repository) throw new Error("Home Project repository is unavailable.");
    return {
        kind: "home-project",
        projectId,
        repositoryId,
        ...context,
        registrationDigest: createHash("sha256")
            .update(JSON.stringify({ personalOwner: record.personalOwner, repository }))
            .digest("hex"),
    };
}
/** Local trusted registration only; a transport request cannot create or select this authority. */
export async function registerHomeProjectOwner(input: HomeProjectRegistration): Promise<HomeProjectOwner> {
    requireProjectId(input.projectId, "Project ID");
    requireId(input.repositoryId, "repository ID");
    if (!input.displayName.trim() || input.displayName.length > 240) throw new Error("Invalid Project display name.");
    const context = contextFor({});
    if (context.personalOwner.kind !== "execution-account")
        throw new Error("Home store registration belongs to this account only.");
    const path = recordPath(context.executionAccountHome, input.projectId);
    ensurePrivateDir(dirname(path));
    const lock = openNativeFileLock(join(dirname(path), "identity.lock"));
    try {
        await lock.lock(true);
        const record: ProjectRecord = readRecord(path, input.projectId) || {
            version: 1 as const,
            projectId: input.projectId,
            displayName: input.displayName,
            personalOwner: context.personalOwner,
            repositories: [],
        };
        if (
            record.personalOwner.kind !== context.personalOwner.kind ||
            record.personalOwner.identity !== context.personalOwner.identity
        )
            throw new Error("Project belongs to another personal owner.");
        if (!record.repositories.some((entry) => entry.repositoryId === input.repositoryId)) {
            record.repositories.push({
                repositoryId: input.repositoryId,
                remote: null,
                decision: "new",
                checkouts: [],
            });
            writeJsonAtomically(path, record);
        }
        return inspectHomeProjectOwner(input.projectId, input.repositoryId);
    } finally {
        lock.close();
    }
}
export function assertProjectStoreIdentity(identity: ProjectStoreIdentity): void {
    verifyExecutionAccountHome(identity);
    if (isHomeProjectOwner(identity)) {
        const current = inspectHomeProjectOwner(identity.projectId, identity.repositoryId);
        if (
            current.registrationDigest !== identity.registrationDigest ||
            current.executionAccountHome !== identity.executionAccountHome ||
            current.personalOwner.identity !== identity.personalOwner.identity
        )
            throw new Error("Home Project authority changed.");
        return;
    }
    const inspected = inspectProjectIdentity(identity.checkoutRoot, {
        context: {
            executionAccountHome: identity.executionAccountHome,
            personalOwner: identity.personalOwner,
        },
    });
    if (
        inspected.kind !== "existing" ||
        inspected.identity.projectId !== identity.projectId ||
        inspected.identity.repositoryId !== identity.repositoryId ||
        inspected.identity.checkoutId !== identity.checkoutId ||
        inspected.identity.personalOwner.kind !== identity.personalOwner.kind ||
        inspected.identity.personalOwner.identity !== identity.personalOwner.identity ||
        inspected.identity.executionAccountHome !== identity.executionAccountHome
    )
        throw new Error("Project store authority changed.");
}
export async function withHomeProjectOwner<T>(owner: HomeProjectOwner, run: () => Promise<T>): Promise<T> {
    assertProjectStoreIdentity(owner);
    return await homeProjectOwners.run(owner, run);
}

/** Execution capabilities require a real checkout, never a home-state directory. */
export function requireProjectCheckout(identity: ProjectStoreIdentity): ProjectIdentity {
    if (isHomeProjectOwner(identity)) throw new Error("This operation belongs to the execution host.");
    return identity;
}
