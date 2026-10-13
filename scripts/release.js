import { captureScriptProcess } from "./script-process.ts";
import process from "node:process";
/**
 * @module scripts/release
 *
 * WLD release orchestration helpers. The script owns source/tag preflight and
 * Git tag publication; the GitHub Actions tag workflow owns qualification and
 * host release creation.
 */

const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/;
const WLD_RELEASE_ASSET_SUFFIXES = Object.freeze([
    "darwin-arm64",
    "darwin-x64",
    "linux-x64",
    "linux-arm64",
    "windows-x64",
]);
const LEGACY_CANDIDATE_SERIES = new Set([
    "v0.8.16",
    "v0.9.0",
    "v0.9.2",
    "v0.9.3",
    "v0.9.4",
    "v0.9.6",
    "v0.10.1",
]);

/**
 * @typedef {"candidate" | "stable"} ReleaseKind
 */

/**
 * @typedef {Object} ReleaseTag
 * @property {string} tag
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {number | undefined} rc
 * @property {ReleaseKind} kind
 * @property {string} stableTag
 */

/**
 * @typedef {Object} CommandResult
 * @property {boolean} success
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {(command: string, args: string[], options?: { cwd?: string, env?: Record<string, string> }) => Promise<CommandResult>} CommandRunner
 */

/**
 * @typedef {Object} ReleasePort
 * @property {CommandRunner} run
 * @property {(message: string) => void} log
 */

/**
 * @typedef {Object} CandidateSource
 * @property {string} commit
 * @property {string} branch
 * @property {"legacy-head" | "new-branch" | "remote-branch"} mode
 */

/**
 * @param {string} value
 */
function assertSafeTagText(value) {
    if (!value) throw new Error(`Unsafe release tag: ${JSON.stringify(value)}`);
    for (const character of value) {
        const code = character.charCodeAt(0);
        if (code <= 0x1f || code === 0x7f || /\s/.test(character) || character === "/" || character === "\\") {
            throw new Error(`Unsafe release tag: ${JSON.stringify(value)}`);
        }
    }
}

/**
 * @param {string} tag
 * @returns {ReleaseTag}
 */
export function parseReleaseTag(tag) {
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

/**
 * @param {string} candidateTag
 * @returns {string}
 */
export function stableTagForCandidate(candidateTag) {
    const parsed = parseReleaseTag(candidateTag);
    if (parsed.kind !== "candidate") throw new Error(`Not a Candidate tag: ${candidateTag}`);
    return parsed.stableTag;
}

/**
 * @param {ReleaseTag} left
 * @param {ReleaseTag} right
 */
export function compareReleaseTags(left, right) {
    for (const key of /** @type {const} */ (["major", "minor", "patch"])) {
        if (left[key] !== right[key]) return left[key] - right[key];
    }
    const leftRc = left.rc ?? Number.POSITIVE_INFINITY;
    const rightRc = right.rc ?? Number.POSITIVE_INFINITY;
    return leftRc - rightRc;
}

/**
 * @param {string[]} tags
 * @returns {string | undefined}
 */
export function nextCandidateTag(tags) {
    const parsed = tags.map((tag) => {
        try {
            return parseReleaseTag(tag);
        } catch {
            return null;
        }
    }).filter((tag) => tag !== null);
    const stableTags = /** @type {ReleaseTag[]} */ (parsed).filter((tag) => tag.kind === "stable");
    stableTags.sort(compareReleaseTags);
    const lastStable = stableTags.at(-1);
    if (!lastStable) return undefined;
    const base = `v${lastStable.major}.${lastStable.minor}.${lastStable.patch + 1}`;
    const candidates = /** @type {ReleaseTag[]} */ (parsed).filter((tag) =>
        tag.stableTag === base && tag.rc !== undefined
    );
    const nextRc = Math.max(0, ...candidates.map((tag) => tag.rc || 0)) + 1;
    return `${base}-rc.${nextRc}`;
}

/**
 * @param {string[]} tags
 * @returns {string | undefined}
 */
export function previousStableTag(tags) {
    const stable = /** @type {ReleaseTag[]} */ (tags.map((tag) => {
        try {
            return parseReleaseTag(tag);
        } catch {
            return null;
        }
    }).filter((tag) => tag?.kind === "stable"));
    stable.sort(compareReleaseTags);
    return stable.at(-1)?.tag;
}

/**
 * @param {string} tag
 * @returns {{ tag: string, kind: ReleaseKind, buildVersion: string, prerelease: boolean, makeLatest: boolean }}
 */
export function releaseMetadataForTag(tag) {
    const parsed = parseReleaseTag(tag);
    return {
        tag: parsed.tag,
        kind: parsed.kind,
        buildVersion: parsed.tag,
        prerelease: parsed.kind === "candidate",
        makeLatest: parsed.kind === "stable",
    };
}

/**
 * @returns {CommandRunner}
 */
function defaultRun() {
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

/**
/** @type {ReleasePort} */
const SYSTEM_RELEASE_PORT = Object.freeze({ run: defaultRun(), log: console.log });

/**
 * @param {ReleasePort} deps
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string> }} [options]
 * @returns {Promise<CommandResult>}
 */
export async function runGit(deps, command, args, options = {}) {
    return await deps.run(command, args, options);
}

/**
 * @param {ReleasePort} deps
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string> }} [options]
 * @returns {Promise<CommandResult>}
 */
async function mustRun(deps, label, command, args, options = {}) {
    const result = await deps.run(command, args, options);
    if (!result.success) {
        throw new Error(`${label} failed with exit code ${result.code}: ${result.stderr || result.stdout}`.trim());
    }
    return result;
}

/**
 * @param {string} stdout
 * @returns {string[]}
 */
function splitLines(stdout) {
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * @param {ReleasePort} deps
 * @returns {Promise<string[]>}
 */
export async function listTags(deps) {
    const result = await mustRun(deps, "List release tags", "git", ["tag", "--list", "v*"]);
    return splitLines(result.stdout);
}

/**
 * @param {ReleasePort} deps
 * @returns {Promise<string[]>}
 */
export async function listRemoteTags(deps) {
    const result = await mustRun(deps, "List remote release tags", "git", [
        "ls-remote",
        "--tags",
        "origin",
        "refs/tags/v*",
    ]);
    const tags = new Set();
    for (const line of splitLines(result.stdout)) {
        const ref = line.split(/\s+/)[1];
        if (!ref?.startsWith("refs/tags/")) continue;
        const tag = ref.slice("refs/tags/".length);
        tags.add(tag.endsWith("^{}") ? tag.slice(0, -3) : tag);
    }
    return [...tags];
}

/**
 * @param {ReleasePort} deps
 * @returns {Promise<string[]>}
 */
export async function listAllReleaseTags(deps) {
    return [...new Set([...(await listTags(deps)), ...(await listRemoteTags(deps))])];
}

/**
 * @param {ReleasePort} deps
 * @param {string} tag
 * @returns {Promise<string | undefined>}
 */
export async function resolveLocalTagCommit(deps, tag) {
    assertSafeTagText(tag);
    const result = await deps.run("git", ["rev-parse", `${tag}^{commit}`]);
    if (!result.success) return undefined;
    return result.stdout.trim() || undefined;
}

/**
 * @param {ReleasePort} deps
 * @param {string} tag
 * @returns {Promise<string | undefined>}
 */
export async function resolveRemoteTagCommit(deps, tag) {
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

/**
 * @param {ReleasePort} deps
 * @param {string} branch
 * @returns {Promise<string | undefined>}
 */
async function resolveRemoteBranchCommit(deps, branch) {
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

/**
 * Fetch one remote ref's objects without moving local branches, tags, or remote-tracking refs.
 *
 * @param {ReleasePort} deps
 * @param {string} ref
 */
async function fetchRemoteObjects(deps, ref) {
    await mustRun(deps, `Fetch ${ref}`, "git", [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--refmap=",
        "origin",
        ref,
    ]);
}

/**
 * @param {ReleasePort} deps
 * @param {string} commit
 */
async function assertCommitAvailable(deps, commit) {
    await mustRun(deps, `Read commit ${commit}`, "git", ["cat-file", "-e", `${commit}^{commit}`]);
}

/**
 * @param {ReleasePort} deps
 * @param {string} branch
 * @returns {Promise<string | undefined>}
 */
async function loadRemoteBranchCommit(deps, branch) {
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

/**
 * @param {ReleasePort} deps
 * @param {string} branch
 * @param {string | undefined} expectedCommit
 */
async function assertRemoteBranchUnchanged(deps, branch, expectedCommit) {
    const current = await resolveRemoteBranchCommit(deps, branch);
    if (current !== expectedCommit) {
        throw new Error(
            `Remote release branch ${branch} changed during preflight. Expected ${
                expectedCommit || "no branch"
            }, found ${current || "no branch"}. Run the Candidate preflight again.`,
        );
    }
}

/**
 * @param {ReleasePort} deps
 * @param {string} tag
 * @param {string | undefined} branch
 * @param {Error} cause
 * @returns {Promise<Error>}
 */
async function describePushFailure(deps, tag, branch, cause) {
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

/**
 * @param {ReleasePort} deps
 * @param {string} tag
 */
async function assertTagAvailable(deps, tag) {
    if (await resolveLocalTagCommit(deps, tag)) throw new Error(`Local tag already exists: ${tag}`);
    if (await resolveRemoteTagCommit(deps, tag)) throw new Error(`Remote tag already exists: ${tag}`);
}

/**
 * @param {string} stderr
 */
function isMissingGitHubReleaseError(stderr) {
    return /not\s+found|could\s+not\s+resolve|release\s+.*\s+does\s+not\s+exist/i.test(stderr);
}

/**
 * @param {ReleasePort} deps
 * @param {string} tag
 */
async function assertHostReleaseAbsent(deps, tag) {
    const result = await deps.run("gh", ["release", "view", tag, "--json", "id"]);
    if (result.success) throw new Error(`GitHub release already exists for ${tag}.`);
    const output = `${result.stderr}\n${result.stdout}`;
    if (!isMissingGitHubReleaseError(output)) {
        throw new Error(`Could not verify GitHub release absence for ${tag}: ${output}`.trim());
    }
}

/**
 * @param {string} stdout
 */
function parseJson(stdout) {
    try {
        return JSON.parse(stdout || "null");
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not parse GitHub release JSON: ${message}\n${stdout}`);
    }
}

/**
 * @param {string} tag
 * @returns {string[]}
 */
export function expectedReleaseAssetNames(tag) {
    /** @type {string[]} */
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

/**
 * @param {ReleasePort} deps
 * @param {string} candidateTag
 */
export async function assertCandidatePublished(deps, candidateTag) {
    parseReleaseTag(candidateTag);
    const result = await mustRun(deps, "Read Candidate release", "gh", [
        "release",
        "view",
        candidateTag,
        "--json",
        "isPrerelease,isDraft,assets",
    ]);
    const release = /** @type {{ isDraft?: boolean, isPrerelease?: boolean, assets?: Array<{ name: string }> }} */
        (parseJson(result.stdout));
    if (!release || release.isDraft) throw new Error(`Candidate release is not published: ${candidateTag}`);
    if (!release.isPrerelease) throw new Error(`Candidate release is not marked as a prerelease: ${candidateTag}`);
    const names = new Set((release.assets || []).map((asset) => asset.name));
    for (const expected of expectedReleaseAssetNames(candidateTag)) {
        if (!names.has(expected)) throw new Error(`Candidate release ${candidateTag} is missing asset: ${expected}`);
    }
}

/**
 * @param {ReleasePort} deps
 * @param {string} tag
 * @param {string} targetCommit
 * @param {string} message
 * @param {boolean} dryRun
 */
async function createAndPushTag(deps, tag, targetCommit, message, dryRun) {
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

/**
 * @param {ReleasePort} deps
 * @returns {Promise<string>}
 */
async function headCommit(deps) {
    const result = await mustRun(deps, "Read HEAD", "git", ["rev-parse", "HEAD"]);
    return result.stdout.trim();
}

/**
 * @param {ReleasePort} deps
 * @param {ReleaseTag} parsed
 * @returns {Promise<CandidateSource>}
 */
async function selectCandidateSource(deps, parsed) {
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

/**
 * @param {ReleasePort} deps
 * @param {string} tag
 * @param {CandidateSource} source
 * @param {boolean} dryRun
 */
async function publishCandidate(deps, tag, source, dryRun) {
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

    await assertRemoteBranchUnchanged(
        deps,
        source.branch,
        source.mode === "new-branch" ? undefined : source.commit,
    );
    await mustRun(deps, "Create annotated release tag", "git", [
        "tag",
        "-a",
        tag,
        source.commit,
        "-m",
        message,
    ]);
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

/**
 * @param {ReleasePort} deps
 * @param {string} tag
 * @param {boolean} dryRun
 */
export async function createCandidate(deps, tag, dryRun = false) {
    const parsed = parseReleaseTag(tag);
    if (parsed.kind !== "candidate") throw new Error(`Candidate release requires an rc tag: ${tag}`);
    const existingTags = await listAllReleaseTags(deps);
    const previous = previousStableTag(existingTags);
    if (!previous) throw new Error("Cannot create a Candidate because no previous Stable release tag exists.");
    if (compareReleaseTags(parsed, parseReleaseTag(previous)) <= 0) {
        throw new Error(`Candidate ${tag} must target a version newer than previous Stable ${previous}.`);
    }
    const candidatesForBase = existingTags.map((existing) => {
        try {
            return parseReleaseTag(existing);
        } catch {
            return null;
        }
    }).filter((existing) => existing?.kind === "candidate" && existing.stableTag === parsed.stableTag);
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

/**
 * @param {ReleasePort} deps
 * @param {string} tag
 * @param {boolean} dryRun
 */
export async function createStable(deps, tag, dryRun = false) {
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

/**
 * @param {ReleasePort} deps
 * @param {string} candidateTag
 * @param {boolean} dryRun
 */
export async function promoteCandidate(deps, candidateTag, dryRun = false) {
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

/**
 * @param {string[]} args
 * @returns {{ command: string, tag?: string, candidate?: string, dryRun: boolean }}
 */
export function parseReleaseArgs(args) {
    const [command, ...rest] = args;
    /** @type {{ command: string, tag?: string, candidate?: string, dryRun: boolean }} */
    const options = { command: command || "", dryRun: false };
    for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index];
        if (arg === "--dry-run") options.dryRun = true;
        else if (arg === "--tag") options.tag = rest[++index];
        else if (arg === "--candidate") options.candidate = rest[++index];
        else throw new Error(`Unknown release argument: ${arg}`);
    }
    return options;
}

/**
 * @param {string[]} args
 * @param {ReleasePort} deps
 */
export async function main(args, deps) {
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
        "Usage: release.js metadata --tag <tag> | candidate --tag <tag> [--dry-run] | stable --tag <tag> [--dry-run] | promote --candidate <tag> [--dry-run]",
    );
}

if (import.meta.main) await main(process.argv.slice(2), SYSTEM_RELEASE_PORT);
