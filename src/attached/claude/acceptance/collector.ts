import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
    PHASES,
    REQUIRED_HOST_RUNS,
    field,
    jsonMap,
    type AcceptanceEvidence,
    type CapturedFile,
    type Json,
    type JsonMap,
    type PrivacyEvidence,
    type Snapshot,
} from "./evidence.ts";

import { readHostTraffic } from "./traffic.ts";

const SCOPES = ["runwield-home", "fixture"];

async function walk(
    directory: string,
    prefix: string,
    visit: (path: string, bytes: Buffer) => void,
    errors: string[],
): Promise<void> {
    try {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (prefix === "fixture" && entry.name === ".git") continue;
            const path = `${prefix}/${entry.name}`;
            if (entry.isDirectory()) await walk(join(directory, entry.name), path, visit, errors);
            else if (entry.isFile() || entry.isSymbolicLink()) {
                try {
                    const absolute = join(directory, entry.name);
                    if (entry.isSymbolicLink() && !(await stat(absolute)).isFile()) throw new Error("Not a file link");
                    visit(path, await readFile(absolute));
                } catch {
                    errors.push(`${path}: unreadable`);
                }
            } else errors.push(`${path}: cannot inspect special file`);
        }
    } catch {
        errors.push(`${prefix}: unreadable directory`);
    }
}

function git(root: string, args: string[]): Buffer {
    return execFileSync("git", args, { cwd: join(root, "fixture"), timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
}
function lines(text: string): string[] {
    return text.split(/\r?\n/).filter((line) => line.length > 0);
}

/** Read durable state. Only Claude's own install journey owns its local plugin-enablement file. */
export async function captureSnapshot(
    root: string,
    hostRun: string | null = null,
    host: "claude-code" | "codex" = "claude-code",
): Promise<Snapshot> {
    const snapshot: Snapshot = { hostRun, files: [], git: null, ciRuns: null, ciFinished: null, errors: [] };
    for (const scope of SCOPES) {
        await walk(
            join(root, scope),
            scope,
            (path, bytes) => {
                if (host === "claude-code" && path === "fixture/.claude/settings.local.json") return;
                const file: CapturedFile = { path, sha256: createHash("sha256").update(bytes).digest("hex") };
                if (/\.(json|jsonl|md)$/.test(path)) file.text = bytes.toString("utf8");
                snapshot.files.push(file);
            },
            snapshot.errors,
        );
    }
    // A Plan Branch can be published without changing the invoking checkout.
    const records = snapshot.files.filter((file) => file.path.includes("/workflows/") && file.path.endsWith(".json"));
    for (const file of records) {
        try {
            const record: Json = JSON.parse(file.text ?? "");
            const planId = field(record, "plan", "planId"),
                planName = field(record, "plan", "planName");
            const controller = snapshot.files.find((item) =>
                item.path.endsWith(`/internal/controller/plans/${encodeURIComponent(String(planId))}.json`),
            );
            if (!controller) continue;
            const document: Json = JSON.parse(controller.text ?? "");
            if (field(document, "planId") !== planId || field(document, "planName") !== planName) continue;
            const commit = field(document, "state", "publicationReceipt", "publishedCommit");
            if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit) || typeof planName !== "string") continue;
            const paths = [`docs/plans/${planName}.md`];
            const workRecord = field(record, "closure", "workRecord", "path");
            if (typeof workRecord === "string") paths.push(workRecord);
            for (const path of paths) {
                const bytes = git(root, ["cat-file", "blob", `${commit}:${path}`]);
                snapshot.files.push({
                    path: `published/${commit}/${path}`,
                    sha256: createHash("sha256").update(bytes).digest("hex"),
                    text: bytes.toString("utf8"),
                });
            }
        } catch {
            snapshot.errors.push("fixture/git: cannot read published documents");
        }
    }
    snapshot.files.sort((a, b) => a.path.localeCompare(b.path));
    try {
        const refs: Record<string, string> = {};
        for (const row of lines(git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]).toString())) {
            const [name, hash] = row.split(" ");
            refs[name] = hash;
        }
        const parents: Record<string, string[]> = {};
        for (const row of lines(git(root, ["log", "--all", "--reflog", "--format=%H %P"]).toString())) {
            const [hash, ...ancestors] = row.trim().split(" ");
            parents[hash] = ancestors;
        }
        snapshot.git = {
            branch: git(root, ["symbolic-ref", "--short", "HEAD"]).toString().trim(),
            head: git(root, ["rev-parse", "HEAD"]).toString().trim(),
            status: git(root, [
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
                "--",
                ".",
                ...(host === "claude-code" ? [":(exclude).claude/settings.local.json"] : []),
            ]).toString(),
            refs,
            parents,
        };
        if (!snapshot.git.head || !snapshot.git.branch || !Object.keys(parents).length)
            snapshot.errors.push("fixture/git: incomplete identity");
    } catch {
        snapshot.errors.push("fixture/git: cannot inspect");
    }
    try {
        snapshot.ciRuns = lines(await readFile(join(root, "markers/ci-runs"), "utf8"));
    } catch {
        snapshot.errors.push("markers/ci-runs: unreadable");
    }
    try {
        snapshot.ciFinished = lines(await readFile(join(root, "markers/ci-finished"), "utf8"));
    } catch {
        snapshot.errors.push("markers/ci-finished: unreadable");
    }
    return snapshot;
}

/** Scan bytes, including binary SQLite pages and blobs no longer present in the working tree. */
export async function collectPrivacyEvidence(root: string, sentinels: string[]): Promise<PrivacyEvidence> {
    const result: PrivacyEvidence = { leaks: [], errors: [] };
    if (!sentinels.length || sentinels.some((text) => !text.length)) {
        result.errors.push("privacy: missing sentinel");
        return result;
    }
    const needles = sentinels.map((text) => Buffer.from(text));
    const contains = (bytes: Buffer) => needles.some((needle) => bytes.includes(needle));
    for (const scope of SCOPES) {
        await walk(
            join(root, scope),
            scope,
            (path, bytes) => {
                if (contains(bytes)) result.leaks.push(path);
            },
            result.errors,
        );
    }
    try {
        const objects = lines(
            git(root, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"]).toString(),
        );
        if (!objects.length) throw new Error("No Git objects");
        for (const object of objects) {
            const match = /^([a-f0-9]{40}) (blob|commit|tree|tag)$/.exec(object);
            if (!match) throw new Error("Unknown Git object");
            if (contains(git(root, ["cat-file", match[2], match[1]])))
                result.leaks.push(`fixture/git/${match[2]}/${match[1]}`);
        }
    } catch {
        result.errors.push("fixture/git: cannot inspect history");
    }
    return result;
}

async function readJson(root: string, path: string, errors: string[]): Promise<Json | undefined> {
    try {
        return JSON.parse(await readFile(join(root, path), "utf8"));
    } catch {
        errors.push(`${path}: unreadable JSON`);
        return undefined;
    }
}
async function readLines(root: string, path: string, errors: string[]): Promise<string[]> {
    try {
        return lines(await readFile(join(root, path), "utf8"));
    } catch {
        errors.push(`${path}: unreadable log`);
        return [];
    }
}
async function readRows(root: string, path: string, errors: string[]): Promise<JsonMap[]> {
    const rows: JsonMap[] = [];
    for (const line of await readLines(root, path, errors)) {
        try {
            const row = jsonMap(JSON.parse(line));
            if (!row) throw new Error("Not a record");
            rows.push(row);
        } catch {
            errors.push(`${path}: malformed log row`);
        }
    }
    return rows;
}

function populatedFile(value: Json): boolean {
    return (
        typeof field(value, "path") === "string" &&
        typeof field(value, "sha256") === "string" &&
        (field(value, "text") === undefined || typeof field(value, "text") === "string")
    );
}

/** Collect only from the isolated world and its audit logs. Never invoke a lifecycle operation. */
export async function collectEvidence(root: string, sentinels: string[]): Promise<AcceptanceEvidence> {
    const errors: string[] = [];
    const evidence: AcceptanceEvidence = {
        metadata: jsonMap(await readJson(root, "run.json", errors)) ?? {},
        snapshots: {},
        tools: [],
        toolResults: [],
        hostResults: [],
        hostRuns: [],
        http: await readRows(root, "logs/http.jsonl", errors),
        processes: await readRows(root, "logs/processes.jsonl", errors),
        plugins: await readRows(root, "logs/plugins.jsonl", errors),
        shimArgv: [],
        modelProcesses: await readLines(root, "sentinel-binaries.log", errors),
        proxyHosts: await readLines(root, "proxy-sink.log", errors),
        privacy: await collectPrivacyEvidence(root, sentinels),
        errors,
    };
    for (const line of await readLines(root, "shim-argv.jsonl", errors)) {
        try {
            const args: Json = JSON.parse(line);
            if (!Array.isArray(args) || !args.every((value) => typeof value === "string"))
                throw new Error("Invalid argv");
            evidence.shimArgv.push(args);
        } catch {
            errors.push("shim-argv.jsonl: malformed argv");
        }
    }
    for (const phase of PHASES) {
        const value = jsonMap(await readJson(root, `snapshots/${phase}.json`, errors));
        const state = field(value, "git");
        if (
            !value ||
            (value.hostRun !== null && typeof value.hostRun !== "string") ||
            !Array.isArray(value.files) ||
            !value.files.every((file) => populatedFile(file)) ||
            !Array.isArray(value.errors) ||
            !value.errors.every((error) => typeof error === "string") ||
            !Array.isArray(value.ciFinished) ||
            !value.ciFinished.every((run) => typeof run === "string") ||
            !Array.isArray(value.ciRuns) ||
            !value.ciRuns.every((run) => typeof run === "string") ||
            typeof field(state, "head") !== "string" ||
            typeof field(state, "branch") !== "string" ||
            typeof field(state, "status") !== "string" ||
            !jsonMap(field(state, "refs")) ||
            !jsonMap(field(state, "parents")) ||
            !Object.values(jsonMap(field(state, "refs")) ?? {}).every((ref) => typeof ref === "string") ||
            !Object.values(jsonMap(field(state, "parents")) ?? {}).every(
                (parents) => Array.isArray(parents) && parents.every((parent) => typeof parent === "string"),
            )
        ) {
            errors.push(`snapshots/${phase}.json: incomplete snapshot`);
            continue;
        }
        // Serialized snapshots are made by captureSnapshot, not by model output.
        const snapshot: Snapshot = JSON.parse(JSON.stringify(value));
        evidence.snapshots[phase] = snapshot;
        errors.push(...snapshot.errors.map(() => `snapshots/${phase}.json: capture failed`));
    }
    try {
        const logs = (await readdir(join(root, "logs/claude"))).filter((name) => name.endsWith(".jsonl"));
        if (!logs.length) errors.push("logs/claude: no host logs");
        for (const log of logs) {
            const rows = await readRows(root, `logs/claude/${log}`, errors);
            if (!rows.length) errors.push(`logs/claude/${log}: empty host log`);
            const run = log.replace(/\.jsonl$/, "");
            if (rows.length) evidence.hostRuns.push(run);
            for (const row of rows) {
                const traffic = readHostTraffic(row, run);
                for (const tool of traffic.tools) {
                    if (tool.operation === "review_reply") {
                        const content = field(row, "message", "content");
                        const block = Array.isArray(content)
                            ? content.find(
                                  (value) => field(value, "type") === "tool_use" && field(value, "id") === tool.toolId,
                              )
                            : undefined;
                        const input = jsonMap(field(block, "input"));
                        if (input) tool.input = input;
                    }
                    evidence.tools.push(tool);
                }
                evidence.toolResults.push(...traffic.results);
                if (row.type === "result")
                    evidence.hostResults.push({ run, success: row.subtype === "success" && row.is_error === false });
            }
        }
    } catch {
        errors.push("logs/claude: unreadable directory");
    }
    for (const run of REQUIRED_HOST_RUNS) {
        if (!evidence.hostRuns.includes(run)) errors.push(`logs/claude/${run}.jsonl: missing host run`);
    }
    const saved = evidence.snapshots["inactive-after"];
    const current = await captureSnapshot(root, saved?.hostRun ?? null);
    if (!saved || JSON.stringify(saved) !== JSON.stringify(current))
        errors.push("snapshots/inactive-after.json: differs from current state");
    return evidence;
}
