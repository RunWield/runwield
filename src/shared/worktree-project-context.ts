import { parse as parseJsonc } from "@std/jsonc";
import { basename, dirname, join } from "@std/path";
import { enterProjectRuntime, resolveProjectRuntimeLayout } from "./project-runtime-layout.ts";
import { ensureRunWieldOwnedGitignoreBlock, RUNWIELD_GITIGNORE_BLOCK } from "./runwield-owned-paths.ts";
import { resolvePrimaryCheckoutRoot } from "./primary-checkout.ts";

/** Versionable setup artifacts; these are not disposable .wld/internal runtime state. */
export const PROJECT_CONTEXT_PATHS = [".wld/settings.json", "docs/domain-language.md"] as const;

interface ContextFile {
    path: string;
    content: string;
    sourceDigest?: string;
}

export interface WorktreeProjectContext {
    files: ContextFile[];
    ownedGitignore: boolean;
}

async function git(cwd: string, args: string[]) {
    const result = await new Deno.Command("git", { cwd, args, stdout: "piped", stderr: "piped" }).output();
    return {
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
    };
}

export async function readProjectContextFile(root: string, path: string): Promise<string | null> {
    // Setup paths must stay inside their checkout, including parent directories.
    let current = root;
    for (const part of path.split("/")) {
        current = join(current, part);
        try {
            if ((await Deno.lstat(current)).isSymlink) {
                throw new Error(`Cannot carry project context through a symlink: ${path}`);
            }
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) return null;
            throw error;
        }
    }
    return await Deno.readTextFile(current);
}

export async function readProjectContextRevision(root: string, ref: string, path: string): Promise<string | null> {
    const entry = await git(root, ["ls-tree", ref, "--", path]);
    if (entry.code !== 0) throw new Error(entry.stderr);
    if (!entry.stdout) return null;
    if (!/^100[0-7]{3} blob /.test(entry.stdout)) {
        throw new Error(`Project context must be a regular file: ${ref}:${path}`);
    }
    const result = await git(root, ["show", `${ref}:${path}`]);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout;
}

async function mergeContext(root: string, path: string, base: string, source: string, target: string): Promise<string> {
    const temporary = await Deno.makeTempDir({ prefix: "runwield-project-context-" });
    try {
        const paths = ["target", "base", "source"].map((name) => join(temporary, name));
        for (const [index, content] of [target, base, source].entries()) {
            await Deno.writeTextFile(paths[index], content);
        }
        const result = await git(root, ["merge-file", "-p", ...paths]);
        if (result.code !== 0) {
            throw new Error(
                `Uncommitted project context conflicts with the worktree target: ${path}. ` +
                    "The original files are unchanged; reconcile this file before retrying execution.",
            );
        }
        return result.stdout;
    } finally {
        await Deno.remove(temporary, { recursive: true });
    }
}

/**
 * Capture only uncommitted setup files (staged, unstaged, untracked, or ignored).
 * Merge against the source HEAD so another target branch keeps its own changes.
 * Resolve conflicts before creating a worktree, without modifying the source index.
 */
export async function captureWorktreeProjectContext(root: string, targetRef: string): Promise<WorktreeProjectContext> {
    const files: ContextFile[] = [];
    for (const path of PROJECT_CONTEXT_PATHS) {
        const source = await readProjectContextFile(root, path);
        if (source === null) continue;
        const base = await readProjectContextRevision(root, "HEAD", path);
        if (source === base) continue;
        const target = await readProjectContextRevision(root, targetRef, path);
        if (source === target) continue;
        const content = target === base ? source : await mergeContext(root, path, base ?? "", source, target ?? "");
        files.push({
            path,
            content,
            ...(await isOwnedProjectContext(root, path) ? { sourceDigest: await digest(source) } : {}),
        });
    }
    const ignore = await readProjectContextFile(root, ".gitignore");
    return { files, ownedGitignore: ignore?.includes(RUNWIELD_GITIGNORE_BLOCK.split("\n")[0]) ?? false };
}

/** Only call on a newly created checkout; resumed worktrees own their local edits. */
export async function materializeWorktreeProjectContext(root: string, context: WorktreeProjectContext): Promise<void> {
    for (const file of context.files) {
        await readProjectContextFile(root, file.path);
        await Deno.mkdir(dirname(join(root, file.path)), { recursive: true });
        await Deno.writeTextFile(join(root, file.path), file.content);
    }
    // Recreate only our managed block, never copy unrelated source ignore edits.
    if (context.ownedGitignore || context.files.length > 0) {
        await readProjectContextFile(root, ".gitignore");
        await ensureRunWieldOwnedGitignoreBlock(root);
    }
    if (context.files.length > 0) {
        await enterProjectRuntime(root);
        const files = [];
        for (const file of context.files) {
            files.push({ path: file.path, digest: await digest(file.content), sourceDigest: file.sourceDigest });
        }
        const receipt = receiptPath(root);
        const internalRoot = dirname(receipt);
        await readProjectContextFile(dirname(internalRoot), join(basename(internalRoot), basename(receipt)));
        await Deno.mkdir(dirname(receipt), { recursive: true });
        await Deno.writeTextFile(receipt, JSON.stringify({ files }) + "\n");
    }
}

interface ContextReceiptFile {
    path: string;
    digest: string;
    sourceDigest?: string;
    owned?: boolean;
}

interface ContextReceipt {
    files: ContextReceiptFile[];
}

async function readContextReceipt(root: string): Promise<ContextReceipt> {
    try {
        const receipt: ContextReceipt = JSON.parse(await Deno.readTextFile(receiptPath(root)));
        return { files: Array.isArray(receipt?.files) ? receipt.files : [] };
    } catch (error) {
        if (error instanceof Deno.errors.NotFound || error instanceof SyntaxError) return { files: [] };
        throw error;
    }
}

/** Versionable receipt paths remain delivery inputs after their validated repair. */
export async function recordedProjectContextPaths(root: string): Promise<string[]> {
    const receipt = await readContextReceipt(root);
    const paths: string[] = [];
    for (const path of PROJECT_CONTEXT_PATHS) {
        const file = receipt.files.find((entry) => entry?.path === path);
        if (
            typeof file?.digest === "string" && /^[a-f0-9]{64}$/.test(file.digest) &&
            await readProjectContextFile(root, path) !== null
        ) paths.push(path);
    }
    return paths;
}

export interface ValidationSettingsWrite {
    primaryRoot: string;
    executionRoot: string;
    before: string | null;
    ownedPrimary: boolean;
}

/** Snapshot ownership before the host writes, so existing user edits are not adopted. */
export async function captureValidationSettingsWrite(executionRoot: string): Promise<ValidationSettingsWrite> {
    const primaryRoot = resolvePrimaryCheckoutRoot(executionRoot);
    const path = ".wld/settings.json";
    const before = await readProjectContextFile(primaryRoot, path);
    const head = await git(primaryRoot, ["rev-parse", "HEAD"]);
    const ownedPrimary = head.code === 0 && (
        before === await readProjectContextRevision(primaryRoot, "HEAD", path) ||
        await isOwnedProjectContext(primaryRoot, path) ||
        await isUnchangedTransferredSource(primaryRoot, executionRoot, path)
    );
    return { primaryRoot, executionRoot, before, ownedPrimary };
}

type SettingValue = string | number | boolean | null | SettingValue[] | SettingValues;
interface SettingValues {
    [key: string]: SettingValue;
}

function onlyCommandChanged(before: string | null, after: string, command: string): boolean {
    const previous = parseJsonc(before ?? "{}") as SettingValues;
    const current = parseJsonc(after) as SettingValues;
    if (current.verification_command !== command) return false;
    delete previous.verification_command;
    delete current.verification_command;
    return JSON.stringify(previous) === JSON.stringify(current);
}

/** Retain the host-written command's provenance without replacing other context receipts. */
export async function recordValidationSettingsWrite(snapshot: ValidationSettingsWrite, command: string): Promise<void> {
    const path = ".wld/settings.json";
    const execution = await readProjectContextFile(snapshot.executionRoot, path);
    if (execution === null) return;
    const primary = await readProjectContextFile(snapshot.primaryRoot, path);
    const sourceOwned = snapshot.ownedPrimary && primary !== null &&
        onlyCommandChanged(snapshot.before, primary, command);
    const receipt = await readContextReceipt(snapshot.executionRoot);
    receipt.files = receipt.files.filter((file) => file?.path !== path);
    receipt.files.push({
        path,
        digest: await digest(execution),
        owned: sourceOwned,
        ...(sourceOwned ? { sourceDigest: await digest(primary) } : {}),
    });
    await enterProjectRuntime(snapshot.executionRoot);
    const target = receiptPath(snapshot.executionRoot);
    await Deno.mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(temporary, JSON.stringify(receipt) + "\n", { mode: 0o600 });
    await Deno.rename(temporary, target);
}

function receiptPath(root: string): string {
    return join(resolveProjectRuntimeLayout(root).selected.internalRoot, "worktree-project-context.json");
}

async function digest(content: string): Promise<string> {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Only the captured bytes count as preparation; later edits are implementation. */
export async function isTransferredProjectContext(root: string, path: string, ref?: string): Promise<boolean> {
    if (!PROJECT_CONTEXT_PATHS.some((candidate) => candidate === path)) return false;
    let receipt: ContextReceipt;
    try {
        receipt = JSON.parse(await Deno.readTextFile(receiptPath(root)));
    } catch (error) {
        if (error instanceof Deno.errors.NotFound || error instanceof SyntaxError) return false;
        throw error;
    }
    const recorded = Array.isArray(receipt?.files) ? receipt.files.find((file) => file?.path === path) : undefined;
    if (typeof recorded?.digest !== "string") return false;
    const content = ref ? await readProjectContextRevision(root, ref, path) : await readProjectContextFile(root, path);
    return content !== null && await digest(content) === recorded.digest;
}

/** Transfer identity alone does not prove that RunWield authored the copied edits. */
export async function isOwnedProjectContext(root: string, path: string): Promise<boolean> {
    const receipt = await readContextReceipt(root);
    const file = receipt.files.find((entry) => entry?.path === path);
    return file?.owned === true && await isTransferredProjectContext(root, path);
}

/** Remember successful Init output without copying or changing the output files. */
export async function recordInitializedProjectContext(root: string): Promise<void> {
    await enterProjectRuntime(root);
    const files = [];
    for (const path of PROJECT_CONTEXT_PATHS) {
        const content = await readProjectContextFile(root, path);
        if (content !== null) files.push({ path, digest: await digest(content), owned: true });
    }
    const receipt = receiptPath(root);
    await Deno.mkdir(dirname(receipt), { recursive: true });
    await Deno.writeTextFile(receipt, JSON.stringify({ files }) + "\n");
}

/** Original source bytes may differ from the merged target bytes in the worktree. */
export async function isUnchangedTransferredSource(
    root: string,
    executionRoot: string,
    path: string,
): Promise<boolean> {
    if (!PROJECT_CONTEXT_PATHS.some((candidate) => candidate === path)) return false;
    let receipt: ContextReceipt;
    try {
        receipt = JSON.parse(await Deno.readTextFile(receiptPath(executionRoot)));
    } catch (error) {
        if (error instanceof Deno.errors.NotFound || error instanceof SyntaxError) return false;
        throw error;
    }
    const file = Array.isArray(receipt?.files) ? receipt.files.find((file) => file?.path === path) : undefined;
    const expected = file?.sourceDigest;
    if (typeof expected !== "string") return false;
    const content = await readProjectContextFile(root, path);
    return content !== null && await digest(content) === expected;
}
