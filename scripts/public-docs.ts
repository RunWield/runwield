import { dirname, fromFileUrl, join, normalize, relative, resolve, SEPARATOR } from "@std/path";

/** User documentation lives in its own folder and publishes at the site root. */
const USER_DOCS_DIRECTORY = "user-documentation/";

/** Paths under `docs/`: the user manual, then the Contributing section. */
export const PUBLIC_DOCS = [
    "user-documentation/index.md",
    "user-documentation/quickstart.md",
    "user-documentation/workspace.md",
    "user-documentation/usage.md",
    "user-documentation/workflows.md",
    "user-documentation/sessions.md",
    "user-documentation/collaboration.md",
    "user-documentation/providers.md",
    "user-documentation/settings.md",
    "user-documentation/customization.md",
    "user-documentation/themes.md",
    "user-documentation/mcp.md",
    "user-documentation/troubleshooting.md",
    "contributing.md",
    "plan-lifecycle.md",
    "validation-authority.md",
    "prd/runwield.md",
    "prd/runwield-core-prd.md",
    "prd/runwield-workspace-prd.md",
    "prd/runwield-connect-prd.md",
    "prd/runwield-acp-protocol-prd.md",
] as const;

export interface DocsRelease {
    version: string;
    sourceRef: string;
    releaseUrl: string;
}

const PUBLIC_SET = new Set<string>(PUBLIC_DOCS);
const REPOSITORY_URL = "https://github.com/gandazgul/runwield";

/** Site slug for a public source: user pages at the root, everything else under `contributing/`. */
export function slugFor(path: string): string {
    const name = path.slice(0, -3);
    if (path.startsWith(USER_DOCS_DIRECTORY)) return name.slice(USER_DOCS_DIRECTORY.length);
    return path === "contributing.md" ? "contributing/index" : `contributing/${name}`;
}

export function routeFor(path: string): string {
    const slug = slugFor(path);
    return slug === "index" ? "/" : `/${slug.replace(/\/index$/, "")}/`;
}

function splitTarget(target: string): { path: string; suffix: string } {
    const index = target.search(/[?#]/);
    return index < 0 ? { path: target, suffix: "" } : { path: target.slice(0, index), suffix: target.slice(index) };
}

function rewriteTarget(
    target: string,
    sourcePath: string,
    release: DocsRelease,
    image = false,
): string {
    if (
        !target || target.startsWith("#") || target.startsWith("/") ||
        /^[a-z][a-z+.-]*:/i.test(target) || target.startsWith("//")
    ) return target;
    const { path, suffix } = splitTarget(target);
    const sourceDirectory = dirname(`docs/${sourcePath}`);
    const repositoryPath = normalize(join(sourceDirectory, path)).split(SEPARATOR)
        .join("/");
    const docsPath = repositoryPath.startsWith("docs/") ? repositoryPath.slice(5) : "";
    if (docsPath && PUBLIC_SET.has(docsPath)) {
        return `${routeFor(docsPath)}${suffix}`;
    }
    if (image) return `/docs-assets/${repositoryPath}${suffix}`;
    const kind = path.endsWith("/") || !path.split("/").at(-1)?.includes(".") ? "tree" : "blob";
    return `${REPOSITORY_URL}/${kind}/${encodeURIComponent(release.sourceRef)}/${repositoryPath}${suffix}`;
}

interface LocalTarget {
    target: string;
    image: boolean;
}

function imageReferenceLabels(source: string): Set<string> {
    return new Set(
        Array.from(source.matchAll(/!\[[^\]]*\]\[([^\]]+)\]/g), (match) => match[1].toLowerCase()),
    );
}

function localTargets(source: string): LocalTarget[] {
    const targets = Array.from(
        source.matchAll(/(!?)\[[^\]]*\]\(([^\s)]+)\)/g),
        (match) => ({ target: match[2], image: match[1] === "!" }),
    );
    const imageLabels = imageReferenceLabels(source);
    for (const match of source.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+)/gm)) {
        targets.push({ target: match[2], image: imageLabels.has(match[1].toLowerCase()) });
    }
    return targets;
}

function markdownFragmentIds(source: string): Set<string> {
    const ids = new Set<string>();
    const duplicateCounts = new Map<string, number>();
    for (const match of source.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
        const base = match[1].replace(/<[^>]+>/g, "").replace(/[`*_~]/g, "").trim().toLowerCase()
            .replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
        const count = duplicateCounts.get(base) ?? 0;
        ids.add(count === 0 ? base : `${base}-${count}`);
        duplicateCounts.set(base, count + 1);
    }
    for (const match of source.matchAll(/\bid=["']([^"']+)["']/g)) ids.add(match[1]);
    return ids;
}

async function validateLocalTargets(
    projectRoot: string,
    source: string,
    sourcePath: string,
): Promise<string[]> {
    const images: string[] = [];
    for (const localTarget of localTargets(source)) {
        const { target, image } = localTarget;
        if (
            !target || target.startsWith("/") ||
            /^[a-z][a-z+.-]*:/i.test(target) || target.startsWith("//")
        ) continue;
        const { path, suffix } = splitTarget(target);
        const repositoryPath = path
            ? resolve(projectRoot, dirname(`docs/${sourcePath}`), path)
            : resolve(projectRoot, "docs", sourcePath);
        const projectRelativePath = relative(projectRoot, repositoryPath);
        if (projectRelativePath.startsWith("..")) {
            throw new Error(`Public document docs/${sourcePath} links outside the repository: ${target}`);
        }
        try {
            const info = await Deno.stat(repositoryPath);
            if (image && !info.isFile) {
                throw new Error(`Public document docs/${sourcePath} uses a directory as an image: ${target}`);
            }
            if (image) images.push(repositoryPath);
            if (suffix.startsWith("#") && info.isFile && repositoryPath.endsWith(".md")) {
                const fragment = decodeURIComponent(suffix.slice(1));
                const targetSource = path ? await Deno.readTextFile(repositoryPath) : source;
                if (!markdownFragmentIds(targetSource).has(fragment)) {
                    throw new Error(`Public document docs/${sourcePath} has a missing fragment: ${target}`);
                }
            }
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
            throw new Error(`Public document docs/${sourcePath} has a missing local target: ${target}`);
        }
    }
    return images;
}

export function renderPublicDocument(
    source: string,
    sourcePath: string,
    release: DocsRelease,
): string {
    const heading = source.match(/^#\s+(.+)$/m);
    if (!heading) {
        throw new Error(`Public document docs/${sourcePath} needs one H1 heading`);
    }
    // Contributor documents may carry their own YAML front matter; the site writes its own.
    let body = source.replace(/^---\n[\s\S]*?\n---\n/, "").replace(heading[0], "").replace(/^\s+/, "");
    body = body.replace(
        /(!?\[[^\]]*\]\()([^\s)]+)(\))/g,
        (_match, open, target, close) =>
            `${open}${rewriteTarget(target, sourcePath, release, open.startsWith("!"))}${close}`,
    );
    const imageLabels = imageReferenceLabels(source);
    body = body.replace(
        /^(\s*\[([^\]]+)\]:\s*)(\S+)/gm,
        (_match, prefix, label, target) =>
            `${prefix}${rewriteTarget(target, sourcePath, release, imageLabels.has(label.toLowerCase()))}`,
    );
    const title = JSON.stringify(heading[1].trim());
    const editUrl = JSON.stringify(`${REPOSITORY_URL}/edit/docs/stable/docs/${sourcePath}`);
    return `---\ntitle: ${title}\ndescription: ${
        JSON.stringify(`RunWield ${heading[1].trim()}`)
    }\neditUrl: ${editUrl}\n---\n\n${body}`;
}

export async function stagePublicDocs(
    projectRoot: string,
    outputDirectory: string,
): Promise<void> {
    const releasePath = join(projectRoot, "docs-site", "release.json");
    const release = JSON.parse(
        await Deno.readTextFile(releasePath),
    ) as DocsRelease;
    await Deno.remove(outputDirectory, { recursive: true }).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    await Deno.mkdir(outputDirectory, { recursive: true });
    const assetDirectory = join(projectRoot, "docs-site", "public", "docs-assets");
    await Deno.remove(assetDirectory, { recursive: true }).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    for (const path of PUBLIC_DOCS) {
        const source = await Deno.readTextFile(join(projectRoot, "docs", path));
        const images = await validateLocalTargets(projectRoot, source, path);
        for (const image of images) {
            const destination = join(assetDirectory, relative(projectRoot, image));
            await Deno.mkdir(dirname(destination), { recursive: true });
            await Deno.copyFile(image, destination);
        }
        const destination = join(outputDirectory, `${slugFor(path)}.md`);
        await Deno.mkdir(dirname(destination), { recursive: true });
        await Deno.writeTextFile(destination, renderPublicDocument(source, path, release));
    }
}

if (import.meta.main) {
    const scriptDirectory = dirname(fromFileUrl(import.meta.url));
    const projectRoot = resolve(scriptDirectory, "..");
    const output = join(projectRoot, "docs-site", "src", "content", "docs");
    await stagePublicDocs(projectRoot, output);
    console.log(
        `Staged ${PUBLIC_DOCS.length} public documents in ${relative(projectRoot, output)}`,
    );
}
