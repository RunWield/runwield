import { captureScriptProcess } from "./script-process.ts";
import type { ScriptProcessOptions, ScriptProcessTextOutput } from "./script-process.ts";
import process from "node:process";
/**
 * @module scripts/release
 *
 * WLD release orchestration helpers. The script owns source/tag preflight and
 * Git tag publication; the GitHub Actions tag workflow owns qualification and
 * host release creation.
 */

const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/;
const WLD_RELEASE_ASSET_SUFFIXES = Object.freeze(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]);
const LEGACY_CANDIDATE_SERIES = new Set(["v0.8.16", "v0.9.0", "v0.9.2", "v0.9.3", "v0.9.4", "v0.9.6", "v0.10.1"]);

export type ReleaseKind = "candidate" | "stable";

export interface ReleaseTag {
    tag: string;
    major: number;
    minor: number;
    patch: number;
    rc: number | undefined;
    kind: ReleaseKind;
    stableTag: string;
}

type ReleaseVersionField = keyof Pick<ReleaseTag, "major" | "minor" | "patch">;
export type CommandResult = ScriptProcessTextOutput;

export interface CommandOptions extends Pick<ScriptProcessOptions, "cwd"> {
    env?: Record<string, string>;
}

export type CommandRunner = (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

export interface ReleasePort {
    run: CommandRunner;
    log: (message: string) => void;
}

export interface CandidateSource {
    commit: string;
    branch: string;
    mode: "legacy-head" | "new-branch" | "remote-branch";
}

export interface ReleaseMetadata extends Pick<ReleaseTag, "tag" | "kind"> {
    buildVersion: string;
    prerelease: boolean;
    makeLatest: boolean;
}

interface PublishedReleaseAsset {
    name: string;
}

interface PublishedRelease {
    isDraft?: boolean;
    isPrerelease?: boolean;
    assets?: PublishedReleaseAsset[];
}

export interface ReleaseArgs {
    command: string;
    tag?: string;
    candidate?: string;
    dryRun: boolean;
}

function assertSafeTagText(value: string) {
    if (!value) throw new Error(`Unsafe release tag: ${JSON.stringify(value)}`);
    for (const character of value) {
        const code = character.charCodeAt(0);
        if (code <= 0x1f || code === 0x7f || /\s/.test(character) || character === "/" || character === "\\") {
            throw new Error(`Unsafe release tag: ${JSON.stringify(value)}`);
        }
    }
}

export function parseReleaseTag(tag: string): ReleaseTag {
    assertSafeTagText(tag);
    const match = tag.match(RELEASE_TAG_PATTERN);
    if (!match) throw new Error(`Unsupported release tag: ${tag}`);
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    const rc = match[4] === undefined ? undefined : Number(match[4]);
    if (rc !== undefined && rc < 1) throw new Error(`Release Candidate ordinal must be positive: ${tag}`);
    const stableTag = `v${major}.${minor}.${patch}`;
    return { tag, major, minor, patch, rc, kind: rc === undefined ? "stable" : "candidate", stableTag };
}

export function stableTagForCandidate(candidateTag: string) {
    const parsed = parseReleaseTag(candidateTag);
    if (parsed.kind !== "candidate") throw new Error(`Not a Candidate tag: ${candidateTag}`);
    return parsed.stableTag;
}

export function compareReleaseTags(left: ReleaseTag, right: ReleaseTag) {
    for (const key of ["major", "minor", "patch"] satisfies ReleaseVersionField[]) {
        if (left[key] !== right[key]) return left[key] - right[key];
    }
    const leftRc = left.rc ?? Number.POSITIVE_INFINITY;
    const rightRc = right.rc ?? Number.POSITIVE_INFINITY;
    return leftRc - rightRc;
}

export function nextCandidateTag(tags: string[]) {
    const parsed = tags
        .map((tag) => {
            try {
                return parseReleaseTag(tag);
            } catch {
                return null;
            }
        })
        .filter((tag): tag is ReleaseTag => tag !== null);
    const stableTags = parsed.filter((tag) => tag.kind === "stable");
    stableTags.sort(compareReleaseTags);
    const lastStable = stableTags.at(-1);
    if (!lastStable) return undefined;
    const base = `v${lastStable.major}.${lastStable.minor}.${lastStable.patch + 1}`;
    const candidates = parsed.filter((tag) => tag.stableTag === base && tag.rc !== undefined);
    const nextRc = Math.max(0, ...candidates.map((tag) => tag.rc || 0)) + 1;
    return `${base}-rc.${nextRc}`;
}

export function previousStableTag(tags: string[]) {
    const stable = tags
        .map((tag) => {
            try {
                return parseReleaseTag(tag);
            } catch {
                return null;
            }
        })
        .filter((tag): tag is ReleaseTag => tag?.kind === "stable");
    stable.sort(compareReleaseTags);
    return stable.at(-1)?.tag;
}

export function releaseMetadataForTag(tag: string): ReleaseMetadata {
    const parsed = parseReleaseTag(tag);
    return {
        tag: parsed.tag,
        kind: parsed.kind,
        buildVersion: parsed.tag,
        prerelease: parsed.kind === "candidate",
        makeLatest: parsed.kind === "stable",
    };
}

function defaultRun(): CommandRunner {
    return async (command, args, options = {}) => {
        const output = await captureScriptProcess(command, {
            args,
            cwd: options.cwd,
            env: options.env,
            stdout: "piped",
            stderr: "piped",
        });
        const decoder = new TextDecoder();
        return {
            success: output.success,
            code: output.code,
            stdout: decoder.decode(output.stdout),
            stderr: decoder.decode(output.stderr),
        };
    };
}

const SYSTEM_RELEASE_PORT: ReleasePort = Object.freeze({ run: defaultRun(), log: console.log });

export async function runGit(
    deps: ReleasePort,
    command: string,
    args: string[],
    options: CommandOptions = {},
): Promise<CommandResult> {
    return await deps.run(command, args, options);
}

async function mustRun(
    deps: ReleasePort,
    label: string,
    command: string,
    args: string[],
    options: CommandOptions = {},
) {
    const result = await deps.run(command, args, options);
    if (!result.success) {
        throw new Error(`${label} failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim());
    }
    return result;
}

function splitLines(stdout: string) {
    return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

export async function listTags(deps: ReleasePort) {
    const result = await mustRun(deps, "List release tags", "git", ["tag", "--list", "v*"]);
    return splitLines(result.stdout);
}

export async function listRemoteTags(deps: ReleasePort) {
    const result = await mustRun(deps, "List remote release tags", "git", [
        "ls-remote",
        "--tags",
        "origin",
        "refs/tags/v*",
    ]);
    const tags = new Set<string>();
    for (const line of splitLines(result.stdout)) {
        const ref = line.split(/\s+/)[1];
        if (!ref?.startsWith("refs/tags/")) continue;
        const tag = ref.slice("refs/tags/".length);
        tags.add(tag.endsWith("^{}") ? tag.slice(0, -3) : tag);
    }
    return [...tags];
}

export async function listAllReleaseTags(deps: ReleasePort) {
    return [...new Set([...(await listTags(deps)), ...(await listRemoteTags(deps))])];
}

export async function resolveLocalTagCommit(deps: ReleasePort, tag: string) {
    assertSafeTagText(tag);
    const result = await deps.run("git", ["rev-parse", `${tag}^{commit}`]);
    if (!result.success) return undefined;
    return result.stdout.trim() || undefined;
}

export async function resolveRemoteTagCommit(deps: ReleasePort, tag: string) {
    assertSafeTagText(tag);
    const result = await deps.run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}*`]);
    if (!result.success) throw new Error(`Failed to inspect remote tag ${tag}: ${result.stderr || result.stdout}`);
    let tagObject;
    let peeledCommit;
    for (const line of splitLines(result.stdout)) {
        const [objectId, ref] = line.split(/\s+/);
        if (ref === `refs/tags/${tag}^{}`) peeledCommit = objectId;
        else if (ref === `refs/tags/${tag}`) tagObject = objectId;
    }
    return peeledCommit || tagObject || undefined;
}

async function resolveRemoteBranchCommit(deps: ReleasePort, branch: string) {
    const ref = `refs/heads/${branch}`;
    const result = await deps.run("git", ["ls-remote", "--heads", "origin", ref]);
    if (!result.success) {
        throw new Error(`Failed to inspect remote branch ${branch}: ${result.stderr || result.stdout}`);
    }
    for (const line of splitLines(result.stdout)) {
        const [objectId, remoteRef] = line.split(/\s+/);
        if (remoteRef === ref) return objectId;
    }
    return undefined;
}

async function fetchRemoteObjects(deps: ReleasePort, ref: string) {
    await mustRun(deps, `Fetch ${ref}`, "git", [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--refmap=",
        "origin",
        ref,
    ]);
}

async function assertCommitAvailable(deps: ReleasePort, commit: string) {
    await mustRun(deps, `Read commit ${commit}`, "git", ["cat-file", "-e", `${commit}^{commit}`]);
}

async function loadRemoteBranchCommit(deps: ReleasePort, branch: string) {
    const commit = await resolveRemoteBranchCommit(deps, branch);
    if (!commit) return undefined;

    const ref = `refs/heads/${branch}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        await fetchRemoteObjects(deps, ref);
        const current = await resolveRemoteBranchCommit(deps, branch);
        if (!current) throw new Error(`Remote release branch disappeared during preflight: ${branch}`);
        if (current !== commit) {
            throw new Error(
                `Remote release branch ${branch} changed during preflight. Expected ${commit}, found ${current}. Run the Candidate preflight again.`,
            );
        }
        const available = await deps.run("git", ["cat-file", "-e", `${commit}^{commit}`]);
        if (available.success) return commit;
    }
    throw new Error(`Could not read remote release branch commit during preflight: ${branch} at ${commit}`);
}

async function assertRemoteBranchUnchanged(deps: ReleasePort, branch: string, expectedCommit: string | undefined) {
    const current = await resolveRemoteBranchCommit(deps, branch);
    if (current !== expectedCommit) {
        throw new Error(
            `Remote release branch ${branch} changed during preflight. Expected ${
                expectedCommit || "no branch"
            }, found ${current || "no branch"}. Run the Candidate preflight again.`,
        );
    }
}

async function describePushFailure(
    deps: ReleasePort,
    tag: string,
    branch: string | undefined,
    cause: Error,
): Promise<Error> {
    try {
        const remoteTag = await resolveRemoteTagCommit(deps, tag);
        const remoteBranch = branch ? await resolveRemoteBranchCommit(deps, branch) : undefined;
        const branchState = branch ? `; origin ${branch} is ${remoteBranch || "absent"}` : "";
        return new Error(
            `${cause.message}\nPublication state: local tag ${tag} remains; origin tag is ${
                remoteTag || "absent"
            }${branchState}.`,
        );
    } catch (inspectionError) {
        const message = inspectionError instanceof Error ? inspectionError.message : String(inspectionError);
        return new Error(
            `${cause.message}\nPublication state: local tag ${tag} remains; remote state could not be verified: ${message}`,
        );
    }
}

async function assertTagAvailable(deps: ReleasePort, tag: string) {
    if (await resolveLocalTagCommit(deps, tag)) throw new Error(`Local tag already exists: ${tag}`);
    if (await resolveRemoteTagCommit(deps, tag)) throw new Error(`Remote tag already exists: ${tag}`);
}

function isMissingGitHubReleaseError(stderr: string) {
    return /not\s+found|could\s+not\s+resolve|release\s+.*\s+does\s+not\s+exist/i.test(stderr);
}

async function assertHostReleaseAbsent(deps: ReleasePort, tag: string) {
    const result = await deps.run("gh", ["release", "view", tag, "--json", "id"]);
    if (result.success) throw new Error(`GitHub release already exists for ${tag}.`);
    const output = `${result.stderr}\n${result.stdout}`;
    if (!isMissingGitHubReleaseError(output)) {
        throw new Error(`Could not verify GitHub release absence for ${tag}: ${output}`.trim());
    }
}

function parseJson(stdout: string): PublishedRelease | null {
    try {
        return JSON.parse(stdout || "null");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not parse GitHub release JSON: ${message}\n${stdout}`);
    }
}

export function expectedReleaseAssetNames(tag: string) {
    const names = ["SHA256SUMS", "config.schema.json"];
    for (const suffix of WLD_RELEASE_ASSET_SUFFIXES) {
        names.push(
            `wld-${tag}-${suffix}.tar.gz`,
            `wld-${tag}-${suffix}.tar.zst`,
            `wld-${tag}-${suffix}.tar.gz.sha256`,
            `wld-${tag}-${suffix}.tar.zst.sha256`,
        );
    }
    return names;
}

export async function assertCandidatePublished(deps: ReleasePort, candidateTag: string) {
    parseReleaseTag(candidateTag);
    const result = await mustRun(deps, "Read Candidate release", "gh", [
        "release",
        "view",
        candidateTag,
        "--json",
        "isPrerelease,isDraft,assets",
    ]);
    const release = parseJson(result.stdout);
    if (!release || release.isDraft) throw new Error(`Candidate release is not published: ${candidateTag}`);
    if (!release.isPrerelease) throw new Error(`Candidate release is not marked as a prerelease: ${candidateTag}`);
    const names = new Set((release.assets || []).map((asset) => asset.name));
    for (const expected of expectedReleaseAssetNames(candidateTag)) {
        if (!names.has(expected)) throw new Error(`Candidate release ${candidateTag} is missing asset: ${expected}`);
    }
}

async function createAndPushTag(
    deps: ReleasePort,
    tag: string,
    targetCommit: string,
    message: string,
    dryRun: boolean,
) {
    const { log } = deps;
    if (dryRun) {
        log(`[dry-run] would create annotated tag ${tag} at ${targetCommit}`);
        log(`[dry-run] would push refs/tags/${tag} to origin`);
        return;
    }
    await mustRun(deps, "Create annotated release tag", "git", ["tag", "-a", tag, targetCommit, "-m", message]);
    try {
        await mustRun(deps, "Push release tag", "git", ["push", "origin", `refs/tags/${tag}`]);
    } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw await describePushFailure(deps, tag, undefined, cause);
    }
}

async function headCommit(deps: ReleasePort) {
    const result = await mustRun(deps, "Read HEAD", "git", ["rev-parse", "HEAD"]);
    return result.stdout.trim();
}

async function selectCandidateSource(deps: ReleasePort, parsed: ReleaseTag): Promise<CandidateSource> {
    const branch = `release/${parsed.stableTag}`;
    if (LEGACY_CANDIDATE_SERIES.has(parsed.stableTag)) {
        return { commit: await headCommit(deps), branch, mode: "legacy-head" };
    }

    const branchCommit = await loadRemoteBranchCommit(deps, branch);
    if (parsed.rc === 1) {
        if (branchCommit) return { commit: branchCommit, branch, mode: "remote-branch" };
        return { commit: await headCommit(deps), branch, mode: "new-branch" };
    }
    if (!branchCommit) {
        throw new Error(`Remote release branch does not exist for ${parsed.tag}: ${branch}`);
    }

    const previousTag = `${parsed.stableTag}-rc.${(parsed.rc || 1) - 1}`;
    const previousCommit = await resolveRemoteTagCommit(deps, previousTag);
    if (!previousCommit) throw new Error(`Previous Candidate tag does not exist on origin: ${previousTag}`);
    await fetchRemoteObjects(deps, `refs/tags/${previousTag}`);
    await assertCommitAvailable(deps, previousCommit);
    const ancestry = await deps.run("git", ["merge-base", "--is-ancestor", previousCommit, branchCommit]);
    if (ancestry.code === 1) {
        throw new Error(
            `Remote release branch ${branch} at ${branchCommit} does not descend from ${previousTag} at ${previousCommit}.`,
        );
    }
    if (!ancestry.success) {
        throw new Error(`Could not verify Candidate ancestry: ${ancestry.stderr || ancestry.stdout}`.trim());
    }
    return { commit: branchCommit, branch, mode: "remote-branch" };
}

async function publishCandidate(deps: ReleasePort, tag: string, source: CandidateSource, dryRun: boolean) {
    const message = `Release Candidate ${tag}`;
    deps.log(`Candidate source: ${source.mode === "legacy-head" ? "HEAD" : source.branch} at ${source.commit}`);
    deps.log(`Candidate target tag: ${tag}`);
    deps.log(
        source.mode === "new-branch"
            ? `Candidate publication: create ${source.branch} and ${tag} atomically on origin`
            : `Candidate publication: push ${tag} to origin`,
    );

    if (source.mode === "legacy-head") {
        await createAndPushTag(deps, tag, source.commit, message, dryRun);
        return;
    }
    if (dryRun) {
        if (source.mode === "new-branch") {
            deps.log(`[dry-run] would create ${source.branch} at ${source.commit}`);
            deps.log(`[dry-run] would atomically push refs/heads/${source.branch} and refs/tags/${tag} to origin`);
        } else {
            deps.log(`[dry-run] would create annotated tag ${tag} at ${source.commit}`);
            deps.log(`[dry-run] would push refs/tags/${tag} to origin from ${source.branch}`);
        }
        return;
    }

    await assertRemoteBranchUnchanged(deps, source.branch, source.mode === "new-branch" ? undefined : source.commit);
    await mustRun(deps, "Create annotated release tag", "git", ["tag", "-a", tag, source.commit, "-m", message]);
    try {
        if (source.mode === "new-branch") {
            await mustRun(deps, "Push release branch and tag", "git", [
                "push",
                "--atomic",
                `--force-with-lease=refs/heads/${source.branch}:`,
                "origin",
                `${source.commit}:refs/heads/${source.branch}`,
                `refs/tags/${tag}`,
            ]);
            return;
        }
        await mustRun(deps, "Push release tag", "git", ["push", "origin", `refs/tags/${tag}`]);
    } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw await describePushFailure(deps, tag, source.branch, cause);
    }
}

export async function createCandidate(deps: ReleasePort, tag: string, dryRun = false) {
    const parsed = parseReleaseTag(tag);
    if (parsed.kind !== "candidate") throw new Error(`Candidate release requires an rc tag: ${tag}`);
    const existingTags = await listAllReleaseTags(deps);
    const previous = previousStableTag(existingTags);
    if (!previous) throw new Error("Cannot create a Candidate because no previous Stable release tag exists.");
    if (compareReleaseTags(parsed, parseReleaseTag(previous)) <= 0) {
        throw new Error(`Candidate ${tag} must target a version newer than previous Stable ${previous}.`);
    }
    const candidatesForBase = existingTags
        .map((existing) => {
            try {
                return parseReleaseTag(existing);
            } catch {
                return null;
            }
        })
        .filter((existing) => existing?.kind === "candidate" && existing.stableTag === parsed.stableTag);
    const expectedRc = Math.max(0, ...candidatesForBase.map((existing) => existing?.rc || 0)) + 1;
    if (parsed.rc !== expectedRc) {
        throw new Error(
            `Next Candidate tag for ${parsed.stableTag} must be ${parsed.stableTag}-rc.${expectedRc}, not ${tag}.`,
        );
    }
    await assertTagAvailable(deps, tag);
    await assertTagAvailable(deps, parsed.stableTag);
    await assertHostReleaseAbsent(deps, tag);
    const source = await selectCandidateSource(deps, parsed);
    await publishCandidate(deps, tag, source, dryRun);
}

export async function createStable(deps: ReleasePort, tag: string, dryRun = false) {
    const parsed = parseReleaseTag(tag);
    if (parsed.kind !== "stable") throw new Error(`Stable release requires a stable tag: ${tag}`);
    const commit = await headCommit(deps);
    const existingTags = await listAllReleaseTags(deps);
    const previous = previousStableTag(existingTags);
    if (previous && compareReleaseTags(parsed, parseReleaseTag(previous)) <= 0) {
        throw new Error(`Stable release ${tag} must be newer than previous Stable ${previous}.`);
    }
    const candidateForStable = existingTags.find((existing) => {
        try {
            const existingTag = parseReleaseTag(existing);
            return existingTag.kind === "candidate" && existingTag.stableTag === tag;
        } catch {
            return false;
        }
    });
    if (candidateForStable) {
        throw new Error(
            `Stable ${tag} has Candidate ${candidateForStable}; use release:promote instead of direct Stable.`,
        );
    }
    await assertTagAvailable(deps, tag);
    await assertHostReleaseAbsent(deps, tag);
    await createAndPushTag(deps, tag, commit, `Stable release ${tag}`, dryRun);
}

export async function promoteCandidate(deps: ReleasePort, candidateTag: string, dryRun = false) {
    const parsed = parseReleaseTag(candidateTag);
    if (parsed.kind !== "candidate") throw new Error(`Promotion requires a Candidate tag: ${candidateTag}`);
    const stableTag = parsed.stableTag;
    const existingTags = await listAllReleaseTags(deps);
    const previous = previousStableTag(existingTags);
    if (previous && compareReleaseTags(parseReleaseTag(stableTag), parseReleaseTag(previous)) <= 0) {
        throw new Error(`Promoted Stable ${stableTag} must be newer than previous Stable ${previous}.`);
    }
    await assertTagAvailable(deps, stableTag);
    await assertHostReleaseAbsent(deps, stableTag);
    const candidateCommit = await resolveRemoteTagCommit(deps, candidateTag);
    if (!candidateCommit) throw new Error(`Candidate tag does not exist on origin: ${candidateTag}`);
    const localCandidateCommit = await resolveLocalTagCommit(deps, candidateTag);
    if (localCandidateCommit && localCandidateCommit !== candidateCommit) {
        throw new Error(
            `Local Candidate tag ${candidateTag} resolves to ${localCandidateCommit}, but origin resolves to ${candidateCommit}. Delete or refresh the stale local tag before promotion.`,
        );
    }
    await fetchRemoteObjects(deps, `refs/tags/${candidateTag}`);
    await assertCommitAvailable(deps, candidateCommit);
    await assertCandidatePublished(deps, candidateTag);

    await createAndPushTag(
        deps,
        stableTag,
        candidateCommit,
        `Stable release ${stableTag}\n\nPromoted-From: ${candidateTag}`,
        dryRun,
    );
}

export function parseReleaseArgs(args: string[]): ReleaseArgs {
    const [command, ...rest] = args;
    const options: ReleaseArgs = { command: command || "", dryRun: false };
    for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index];
        if (arg === "--dry-run") options.dryRun = true;
        else if (arg === "--tag") options.tag = rest[++index];
        else if (arg === "--candidate") options.candidate = rest[++index];
        else throw new Error(`Unknown release argument: ${arg}`);
    }
    return options;
}

export async function main(args: string[], deps: ReleasePort) {
    const options = parseReleaseArgs(args);
    if (options.command === "metadata") {
        if (!options.tag) throw new Error("release metadata requires --tag <tag>");
        console.log(JSON.stringify(releaseMetadataForTag(options.tag)));
        return;
    }
    if (options.command === "candidate") {
        if (!options.tag) throw new Error("release candidate requires --tag <candidate-tag>");
        await createCandidate(deps, options.tag, options.dryRun);
        return;
    }
    if (options.command === "stable") {
        if (!options.tag) throw new Error("release stable requires --tag <stable-tag>");
        await createStable(deps, options.tag, options.dryRun);
        return;
    }
    if (options.command === "promote") {
        if (!options.candidate) throw new Error("release promote requires --candidate <candidate-tag>");
        await promoteCandidate(deps, options.candidate, options.dryRun);
        return;
    }
    throw new Error(
        "Usage: release.ts metadata --tag <tag> | candidate --tag <tag> [--dry-run] | stable --tag <tag> [--dry-run] | promote --candidate <tag> [--dry-run]",
    );
}

if (import.meta.main) await main(process.argv.slice(2), SYSTEM_RELEASE_PORT);
