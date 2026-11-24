/** Live GitHub qualification. Creates four test issues and real comments; retains all evidence. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface Issue {
    number: number;
    id: number;
    title: string;
    html_url: string;
    pull_request?: { url: string };
}
interface Comment {
    id: number;
    body: string;
    html_url: string;
    user: { id: number };
}
interface Selection {
    id: string;
    number: number;
    runName: string;
}
interface RecipeSpec {
    projectId: string;
    repository: string;
    repositoryId: string;
    label: string;
    excludeLabels: string[];
    mode: string;
    model: string;
}
interface Intake {
    metadata: { name: string };
    spec: RecipeSpec;
    status?: { phase?: string; selected?: Selection[]; message?: string };
}
interface Run {
    metadata: { name: string; uid: string };
    spec: { projectId: string; input: { prompt: string }; publication?: { repositoryId: string; issueId: string } };
    status?: {
        phase?: string;
        executionName?: string;
        result?: {
            operationId: string;
            publication?: { commentId: string; url: string };
            result: { routingIntent: string; summary: string };
        };
    };
}
interface Pod {
    metadata: { name: string; uid: string };
    status: { phase: string };
}
interface Receipt {
    request: { operationId: string };
    result?: { summary: string };
    response?: { phase: string };
}
interface Evidence {
    batchName?: string;
    suspendBefore?: boolean;
    id: string;
    issues: { key: string; issue: Issue }[];
    fault?: { run: string; operationId: string; pod: string; podUID: string; replacementUID?: string };
    runs?: Run[];
    comments?: { issue: number; comment: Comment }[];
    completed?: boolean;
}
const namespace = process.env.FACTORY_NAMESPACE || "runwield-personal";
const evidencePath = resolve(process.env.FACTORY_EVIDENCE || ".ci-cache/factory-github-live.json");
async function command(args: string[], input?: string, allowFailure = false): Promise<string> {
    const child = Bun.spawn(args, {
        stdin: input === undefined ? "ignore" : new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (code && !allowFailure) throw new Error(`${args.slice(0, 4).join(" ")}: ${stderr}`);
    return stdout.trim();
}
const kube = (args: string[], input?: string, allowFailure = false) =>
    command(["kubectl", "-n", namespace, ...args], input, allowFailure);
const gh = (path: string, body?: string) =>
    command(["gh", "api", path, ...(body === undefined ? [] : ["--method", "POST", "--input", "-"])], body);
let evidence: Evidence;
try {
    evidence = JSON.parse(await readFile(evidencePath, "utf8"));
} catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    evidence = { id: `e2e-${Date.now().toString(36)}`, issues: [] };
}
async function save(): Promise<void> {
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, JSON.stringify(evidence, null, 4) + "\n");
}
async function until<T>(description: string, observe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 600_000;
    let progress = Date.now();
    while (Date.now() < deadline) {
        const result = await observe();
        if (result !== undefined) return result;
        if (Date.now() - progress > 30_000) {
            console.log(`Waiting: ${description}`);
            progress = Date.now();
        }
        await Bun.sleep(500);
    }
    throw new Error(`Timed out: ${description}; evidence at ${evidencePath}`);
}
const original: Intake = JSON.parse(await kube(["get", "githubtriage", "github-test-first-ten", "-o", "json"]));
const repository = original.spec.repository;
const cron: { spec: { suspend?: boolean } } = JSON.parse(
    await kube(["get", "cronjob", "github-test-triage", "-o", "json"]),
);
async function issue(key: string, title: string, body: string): Promise<Issue> {
    const prior = evidence.issues.find((entry) => entry.key === key);
    if (prior) return prior.issue;
    const created: Issue = JSON.parse(
        await gh(
            `repos/${repository}/issues`,
            JSON.stringify({
                title: `[Factory test ${evidence.id}] ${title}`,
                body: `${body}\n\n---\nFactory Router end-to-end test fixture. Classify this request and publish the triage only; no implementation is requested in this run.\nTest case: ${key}; qualification: ${evidence.id}.`,
                labels: ["test"],
            }),
        ),
    );
    evidence.issues.push({ key, issue: created });
    await save();
    console.log(`Created ${created.html_url}`);
    await Bun.sleep(1100);
    return created;
}
async function intake(name: string): Promise<Intake> {
    return JSON.parse(await kube(["get", "githubtriage", name, "-o", "json"]));
}
async function run(name: string): Promise<Run> {
    return JSON.parse(await kube(["get", "factoryrun", name, "-o", "json"]));
}
function finish(name: string): Promise<Intake> {
    return until(`completion of ${name}`, async () => {
        const value = await intake(name);
        return value.status?.phase === "Completed" ? value : undefined;
    });
}
async function wake(suffix: string): Promise<Intake> {
    const job = `${evidence.id}-${suffix}`;
    const existing = await kube(["get", "job", job, "-o", "name"], undefined, true);
    if (!existing) await kube(["create", "job", job, "--from=cronjob/github-test-triage"]);
    const name = `wake-${createHash("sha256").update(job).digest("hex").slice(0, 48)}`;
    await until(
        `admission ${name}`,
        async () => (await kube(["get", "githubtriage", name, "-o", "name"], undefined, true)) || undefined,
    );
    return finish(name);
}
evidence.suspendBefore ??= cron.spec.suspend || false;
await save();
if (evidence.completed)
    throw new Error("This evidence file already passed; use a new FACTORY_EVIDENCE path for another qualification");
await kube(["patch", "cronjob", "github-test-triage", "--type=merge", "-p", '{"spec":{"suspend":true}}']);
try {
    const pages: Issue[][] = JSON.parse(
        await command([
            "gh",
            "api",
            `repos/${repository}/issues?state=open&labels=test&per_page=100`,
            "--paginate",
            "--slurp",
        ]),
    );
    const open = pages.flat();
    const existing: { items: Run[] } = JSON.parse(await kube(["get", "factoryruns", "-o", "json"]));
    const claimed = new Set(
        existing.items
            .filter((value) => value.spec.publication?.repositoryId === original.spec.repositoryId)
            .map((value) => value.spec.publication?.issueId),
    );
    assert.ok(
        open.every(
            (item) =>
                item.pull_request ||
                claimed.has(String(item.id)) ||
                evidence.issues.some((entry) => entry.issue.id === item.id),
        ),
        "Unrelated test issues exist; do not consume them during qualification",
    );
    const first = await issue(
        "batch-recovery",
        "Explain FactoryRun versus StepExecution",
        "Please explain why FactoryRun and StepExecution are separate Kubernetes resources, how a Router result reaches FactoryRun status, and which storage survives worker pod replacement. This is an information request, not a code change.",
    );
    const second = await issue(
        "batch-normal",
        "Correct a documentation typo",
        "A hypothetical Factory README says 'Kubernets' instead of 'Kubernetes' in one sentence. Classify the scope of correcting that spelling error; do not change the repository.",
    );
    await until("new issues visible in GitHub list", async () => {
        const visible: Issue[] = JSON.parse(
            await gh(
                `repos/${repository}/issues?direction=asc&labels=test&page=1&per_page=100&sort=created&state=open`,
            ),
        );
        return [first, second].every((item) => visible.some((entry) => entry.id === item.id)) ? true : undefined;
    });
    const batchName = evidence.batchName || `${evidence.id}-batch`;
    if (!(await kube(["get", "githubtriage", batchName, "-o", "name"], undefined, true))) {
        await kube(
            ["create", "-f", "-"],
            JSON.stringify({
                apiVersion: "factory.runwield.dev/v1alpha1",
                kind: "GitHubTriage",
                metadata: { name: batchName, namespace },
                spec: { ...original.spec, mode: "batch" },
            }),
        );
    }
    const batch = await until("batch selection", async () => {
        const value = await intake(batchName);
        if (value.status?.phase === "Completed" && !value.status.selected?.length)
            throw new Error(
                "Batch selected no issues; preserve its receipt and start a new batch after source visibility is confirmed",
            );
        return value.status?.selected?.length ? value : undefined;
    });
    assert.deepEqual(
        batch.status?.selected?.map((entry) => entry.number),
        [first.number, second.number],
    );
    if (!evidence.fault) {
        await until("admitted worker to kill", async () => {
            for (const selected of batch.status?.selected || []) {
                const value: Run | undefined =
                    JSON.parse(
                        (await kube(["get", "factoryrun", selected.runName, "-o", "json"], undefined, true)) || "null",
                    ) || undefined;
                if (!value || value.status?.phase !== "Running") continue;
                const pods: { items: Pod[] } = JSON.parse(
                    await kube(["get", "pods", "-l", `factory.runwield.dev/run=${selected.runName}`, "-o", "json"]),
                );
                const pod = pods.items.find((item) => item.status.phase === "Running");
                if (!pod) continue;
                const operationId = `${value.metadata.uid}:router`;
                const hash = createHash("sha256").update(operationId).digest("hex");
                const stop =
                    'for dir in /proc/[0-9]*; do read -r name < "$dir/comm" 2>/dev/null || continue; if [ "$name" = wld ]; then kill -STOP "${dir##*/}"; fi; done';
                const raw = await kube(
                    [
                        "exec",
                        pod.metadata.name,
                        "--",
                        "sh",
                        "-c",
                        `${stop}; cat /data/home/.wld/factory/${hash}.json 2>/dev/null`,
                    ],
                    undefined,
                    true,
                );
                const receipt: Receipt | undefined = raw ? JSON.parse(raw) : undefined;
                if (!receipt || receipt.result || receipt.response) {
                    await kube(
                        ["exec", pod.metadata.name, "--", "sh", "-c", stop.replaceAll("-STOP", "-CONT")],
                        undefined,
                        true,
                    );
                    continue;
                }
                assert.equal(receipt.request.operationId, operationId);
                evidence.fault = {
                    run: selected.runName,
                    operationId,
                    pod: pod.metadata.name,
                    podUID: pod.metadata.uid,
                };
                await save();
                await kube(["delete", "pod", pod.metadata.name, "--grace-period=0", "--force", "--wait=false"]);
                console.log(`Killed admitted worker ${pod.metadata.name}; operation ${operationId}`);
                return true;
            }
            return undefined;
        });
    }
    const done = await finish(batchName);
    console.log(`Batch completed: ${done.status?.message}`);
    assert.ok(evidence.fault);
    const recovered = await run(evidence.fault.run);
    assert.equal(recovered.status?.result?.operationId, evidence.fault.operationId);
    const pods: { items: Pod[] } = JSON.parse(
        await kube(["get", "pods", "-l", `factory.runwield.dev/run=${evidence.fault.run}`, "-o", "json"]),
    );
    const replacement = pods.items.find(
        (pod) => pod.metadata.uid !== evidence.fault?.podUID && pod.status.phase === "Succeeded",
    );
    assert.ok(replacement, "replacement worker must succeed");
    evidence.fault.replacementUID = replacement.metadata.uid;
    await save();
    const third = await issue(
        "next-oldest",
        "Explore a future triage dashboard",
        "I want to explore ideas for a desktop view showing admitted Factory runs, routing summaries, and publication links. Help shape the concept before deciding what to build; no implementation yet.",
    );
    const fourth = await issue(
        "next-following",
        "Explain retry behavior",
        "What happens when a Router worker process crashes before saving a triage result? Explain the recovery behavior and how a saved GitHub comment receipt prevents repeat publication. Information only.",
    );
    await until("next issues visible in GitHub list", async () => {
        const visible: Issue[] = JSON.parse(
            await gh(
                `repos/${repository}/issues?direction=asc&labels=test&page=1&per_page=100&sort=created&state=open`,
            ),
        );
        return [third, fourth].every((item) => visible.some((entry) => entry.id === item.id)) ? true : undefined;
    });
    const nextOne = await wake("next-one");
    assert.deepEqual(
        nextOne.status?.selected?.map((entry) => entry.number),
        [third.number],
    );
    console.log(`First wake completed issue #${third.number}`);
    const nextTwo = await wake("next-two");
    assert.deepEqual(
        nextTwo.status?.selected?.map((entry) => entry.number),
        [fourth.number],
    );
    console.log(`Second wake completed issue #${fourth.number}`);
    const empty = await wake("dedup-check");
    assert.equal(empty.status?.selected?.length || 0, 0, "completed labeled issues must not be re-admitted");
    const selections = [
        ...(done.status?.selected || []),
        ...(nextOne.status?.selected || []),
        ...(nextTwo.status?.selected || []),
    ];
    evidence.runs = [];
    evidence.comments = [];
    for (const selected of selections) {
        const completed = await run(selected.runName);
        assert.equal(completed.status?.phase, "Completed");
        const published = completed.status?.result?.publication;
        assert.ok(published);
        const pages: Comment[][] = JSON.parse(
            await command([
                "gh",
                "api",
                `repos/${repository}/issues/${selected.number}/comments?per_page=100`,
                "--paginate",
                "--slurp",
            ]),
        );
        const comments = pages.flat().filter((comment) => comment.body.includes("<!-- runwield-factory:"));
        assert.equal(comments.length, 1, `issue #${selected.number} must have exactly one triage comment`);
        assert.equal(String(comments[0].id), published.commentId);
        assert.equal(comments[0].html_url, published.url);
        const marker = createHash("sha256")
            .update(completed.status?.result?.operationId || "")
            .digest("hex");
        assert.ok(comments[0].body.includes(`<!-- runwield-factory:${marker} -->`));
        evidence.runs.push(completed);
        evidence.comments.push({ issue: selected.number, comment: comments[0] });
        console.log(`Verified #${selected.number}: exactly one comment ${published.url}`);
    }
    evidence.completed = true;
    await save();
    console.log(`PASS: batch, sequential wakes, pod recovery, and duplicate prevention. Evidence: ${evidencePath}`);
} finally {
    await kube([
        "patch",
        "cronjob",
        "github-test-triage",
        "--type=merge",
        "-p",
        JSON.stringify({ spec: { suspend: evidence.suspendBefore } }),
    ]);
    console.log(`Restored CronJob suspend=${evidence.suspendBefore}`);
}
