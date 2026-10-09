import { dirname, join } from "@std/path";
import { enterProjectRuntime, resolveProjectRuntimeLayout } from "./project-runtime-layout.ts";
import { isRunWieldOwnedGitignoreChange } from "./runwield-owned-paths.ts";
import {
    isOwnedProjectContext,
    isUnchangedTransferredSource,
    PROJECT_CONTEXT_PATHS,
    readProjectContextFile,
    readProjectContextRevision,
} from "./worktree-project-context.ts";

const PATHS = [...PROJECT_CONTEXT_PATHS, ".gitignore"];
interface IndexEntry {
    mode: string;
    oid: string;
}
interface SavedFile {
    path: string;
    content: string;
    mode: number | null;
    headContent: string | null;
    index: IndexEntry | null;
}
interface PublicationContextJournal {
    head: string;
    candidate: string;
    files: SavedFile[];
}

async function git(root: string, args: string[]): Promise<string> {
    const result = await new Deno.Command("git", { cwd: root, args, stdout: "piped", stderr: "piped" }).output();
    if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout);
}

function journalPath(root: string): string {
    return join(resolveProjectRuntimeLayout(root).selected.internalRoot, "project-context-publication.json");
}

async function indexEntry(root: string, path: string): Promise<IndexEntry | null> {
    const entry = await git(root, ["ls-files", "--stage", "--", path]);
    if (!entry) return null;
    const match = /^(\d+) ([a-f0-9]+) 0\t[^\n]+\n$/.exec(entry);
    if (!match) throw new Error(`Cannot reconcile an unmerged project file: ${path}`);
    return { mode: match[1], oid: match[2] };
}

async function restoreIndex(root: string, path: string, entry: IndexEntry | null): Promise<void> {
    if (entry) await git(root, ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.oid},${path}`]);
    else await git(root, ["update-index", "--force-remove", "--", path]);
}

function userContextConflict(path: string) {
    return Object.assign(
        new Error(`The project folder has user edits to ${path} that differ from the validated file.`),
        {
            mergeFailureKind: "primary_checkout_dirty",
            blockingPaths: [path],
        },
    );
}

/**
 * Fold only known, unchanged setup output into the validated merge. Save both
 * bytes and staging durably before neutralizing these paths; never stash the repo.
 */
export async function prepareProjectContextPublication(
    root: string,
    executionRoot: string,
    candidate: string,
): Promise<void> {
    await settleProjectContextPublication(root);
    const head = (await git(root, ["rev-parse", "HEAD"])).trim();
    const files: SavedFile[] = [];
    for (const path of PATHS) {
        const content = await readProjectContextFile(root, path);
        if (content === null) continue;
        const headContent = await readProjectContextRevision(root, head, path);
        const index = await indexEntry(root, path);
        const indexed = index ? await git(root, ["cat-file", "blob", index.oid]) : null;
        if (content === headContent && indexed === headContent) continue;
        const incoming = await readProjectContextRevision(root, candidate, path);
        const owned = path === ".gitignore"
            ? isRunWieldOwnedGitignoreChange(headContent ?? "", content)
            : await isOwnedProjectContext(root, path) ||
                await isUnchangedTransferredSource(root, executionRoot, path);
        if (!owned) {
            // Git may overwrite ignored untracked files without reporting a conflict.
            // Protect these known paths explicitly before any merge preparation.
            if (incoming !== headContent) throw userContextConflict(path);
            continue;
        }
        // A distinct staged version is user work, even when the working file is ours.
        if (indexed !== headContent && indexed !== content) {
            if (incoming !== headContent) throw userContextConflict(path);
            continue;
        }
        files.push({ path, content, headContent, index, mode: (await Deno.stat(join(root, path))).mode });
    }
    if (!files.length) return;
    await enterProjectRuntime(root);
    const journal: PublicationContextJournal = { head, candidate, files };
    const path = journalPath(root);
    await Deno.mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(temporary, JSON.stringify(journal) + "\n", { mode: 0o600 });
    await Deno.rename(temporary, path);
    for (const file of files) {
        // Recheck before changing anything, so concurrent edits stay untouched.
        if (
            await readProjectContextFile(root, file.path) !== file.content ||
            JSON.stringify(await indexEntry(root, file.path)) !== JSON.stringify(file.index)
        ) {
            throw new Error(`Project file changed while preparing publication: ${file.path}`);
        }
        if (file.headContent !== null) {
            await git(root, ["restore", "--staged", "--worktree", `--source=${head}`, "--", file.path]);
        } else {
            await restoreIndex(root, file.path, null);
            await Deno.remove(join(root, file.path));
        }
    }
}

/** Restore a failed preparation, or retire copied output after a successful merge. */
export async function settleProjectContextPublication(root: string): Promise<void> {
    const path = journalPath(root);
    let journal: PublicationContextJournal;
    try {
        journal = JSON.parse(await Deno.readTextFile(path));
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
    }
    if (!Array.isArray(journal.files) || journal.files.some((file) => !PATHS.includes(file.path))) {
        throw new Error("Invalid project-context publication recovery record.");
    }
    const head = (await git(root, ["rev-parse", "HEAD"])).trim();
    if (head !== journal.head) {
        await git(root, ["merge-base", "--is-ancestor", journal.candidate, head]);
    }
    for (const file of journal.files) {
        const published = await readProjectContextRevision(root, head, file.path);
        // The validated merge now owns this file. Do not restore stale Init output.
        if (head !== journal.head && published !== file.headContent) continue;
        const current = await readProjectContextFile(root, file.path);
        if (current !== file.content && current !== file.headContent) {
            throw new Error(`Preserving a concurrent edit to ${file.path}; original setup is saved in ${path}.`);
        }
        const index = await indexEntry(root, file.path);
        const indexed = index ? await git(root, ["cat-file", "blob", index.oid]) : null;
        if (JSON.stringify(index) !== JSON.stringify(file.index) && indexed !== file.headContent) {
            throw new Error(
                `Preserving a concurrent staged edit to ${file.path}; original staging is saved in ${path}.`,
            );
        }
        await Deno.mkdir(dirname(join(root, file.path)), { recursive: true });
        await Deno.writeTextFile(join(root, file.path), file.content);
        if (file.mode !== null && Deno.build.os !== "windows") await Deno.chmod(join(root, file.path), file.mode);
        await restoreIndex(root, file.path, file.index);
    }
    await Deno.remove(path);
}
