import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AcceptanceWorld, PrerequisiteError } from "./world.ts";
import { ClaudeHost, HostTurnEnded } from "./host.ts";
import { ReviewPage } from "./review.ts";
import { collectEvidence } from "./collector.ts";
import { evaluateEvidence } from "./evaluator.ts";
import { field, type JsonMap, type AcceptanceSummary, type Phase } from "./evidence.ts";

export interface AcceptanceOptions {
    root: string;
    checkout: string;
    claude: string;
    keep: boolean;
}
const FEATURE =
    "Add a portable shell greeting command: sh ./greet.sh NAME prints Hello, NAME! Names with spaces must work. A missing NAME must exit nonzero and print usage to stderr. Document usage and add focused shell tests. Keep the existing check.sh unchanged; it is the validation command and its marker and sleep are test instrumentation. Use an isolated worktree and default Plan Branch delivery.";
const CONTINUE =
    "Continue the current RunWield command. Use isolated worktree execution and default Plan Branch delivery. Browser decisions come through the review page. Stop and report a blocking error; do not bypass Core guards.";
const state = (body: JsonMap) => field(body, "workflow", "state");
const action = (body: JsonMap) => field(body, "workflow", "nextAction", "kind");
const round = (body: JsonMap) => field(body, "workflow", "review", "round");

class Journey {
    private hosts: ClaudeHost[] = [];
    private host: ClaudeHost | null = null;
    private deadline = Date.now() + 90 * 60_000;
    constructor(private world: AcceptanceWorld) {}
    private remaining(): number {
        const remaining = this.deadline - Date.now();
        if (remaining <= 0) throw new Error("Acceptance journey timed out");
        return Math.min(600_000, remaining);
    }
    private start(run: string, phase: string, prompt: string): ClaudeHost {
        this.remaining();
        const host = this.world.startHost(run, phase);
        this.hosts.push(host);
        this.host = host;
        host.send(prompt);
        return host;
    }
    private async expect(matches: (body: JsonMap) => boolean): Promise<JsonMap> {
        const host = this.host;
        if (!host) throw new Error("No active Claude host");
        for (let turn = 0; turn < 5; turn++) {
            const waiting = host.waitForCore(
                (body) =>
                    matches(body) ||
                    field(body, "rejection", "code") === "unsupported_host_version" ||
                    field(body, "workflow", "nextAction", "kind") === "return_to_host",
                this.remaining(),
            );
            try {
                const body = await waiting;
                if (!matches(body)) throw new Error("Host cannot continue this FEATURE journey");
                return body;
            } catch (error) {
                if (!(error instanceof HostTurnEnded)) throw error;
                const current = this.world.status();
                if (current.ok !== true) throw new Error("Core status could not restore the workflow");
                host.send(CONTINUE);
            }
        }
        throw new Error("Claude did not continue to the required Core checkpoint");
    }
    private async snapshot(phase: Phase): Promise<void> {
        await this.world.snapshot(phase, this.host?.options.runId ?? null);
    }
    private async ordinary(run: string, phase: Phase, sentinel: string): Promise<void> {
        const host = this.start(
            run,
            phase,
            `Ordinary Claude message: ${sentinel}. Reply with one short greeting. Use no tools and do not write files.`,
        );
        await host.finishTurn(this.remaining());
        await host.stop(phase);
        await this.snapshot(phase);
    }
    cancel(): void {
        this.deadline = 0;
        for (const host of this.hosts)
            void host
                .stop("cancelled", "SIGKILL")
                .catch(() => this.world.issues.push("cleanup: cancelled host did not stop"));
    }
    async close(): Promise<void> {
        for (const host of this.hosts) await host.stop("cleanup");
    }
    async run(metadata: JsonMap): Promise<void> {
        const world = this.world;
        await world.snapshot("initial", null);
        world.plugin("stale-adapter", [
            "marketplace",
            "add",
            join(world.root, "stale-marketplace"),
            "--scope",
            "local",
        ]);
        world.plugin("stale-adapter", ["install", "runwield@runwield", "--scope", "local"]);
        let host = this.start("stale-adapter", "stale-adapter", `/runwield:request ${FEATURE}`);
        await this.expect((body) => body.ok === false && field(body, "rejection", "code") === "incompatible_adapter");
        host.resume();
        await host.finishTurn(this.remaining());
        await host.stop("stale-adapter");
        await this.snapshot("stale-adapter");
        world.plugin("installed", ["uninstall", "runwield@runwield", "--scope", "local"]);
        world.plugin("installed", ["marketplace", "remove", "runwield", "--scope", "local"]);
        world.plugin("installed", ["marketplace", "add", join(world.root, "marketplace"), "--scope", "local"]);
        world.plugin("installed", ["install", "runwield@runwield", "--scope", "local"]);
        await world.snapshot("installed", null);
        await this.ordinary("inactive-before", "inactive-before", world.sentinels[0]);

        host = this.start("request", "request", `/runwield:request ${FEATURE}`);
        let body = await this.expect((body) => body.ok === true && state(body) === "triaging");
        const activated = await world.snapshot("activated", "request");
        const workflowId = field(body, "workflow", "workflowId");
        const record = activated.files.find((file) => file.path.endsWith(`/workflows/${workflowId}.json`));
        const evidence = record?.text ? field(JSON.parse(record.text), "evidence") : undefined;
        if (
            field(evidence, "hostVersion") !== metadata.claudeVersion ||
            field(evidence, "compatibility", "status") === "version_not_reported"
        )
            throw new PrerequisiteError("host-version-evidence");
        await this.expect((body) => body.ok === true && state(body) === "awaiting_planning");
        await this.snapshot("triaged");
        body = await this.expect(
            (body) => body.ok === true && action(body) === "review" && typeof field(body, "review", "url") === "string",
        );
        await this.snapshot("plan-review");
        host.send(
            `Unrelated ordinary message: ${world.sentinels[1]}. Acknowledge it briefly without writing it to project artifacts. Continue the pending review.`,
        );
        let page = new ReviewPage(world.root, body);
        await page.send("plan-chat", "question", "What does the validation command check?");
        body = await this.expect((body) => page.acceptsReply(body));
        await this.snapshot("plan-chat");
        page = new ReviewPage(world.root, body);
        const firstRound = round(body);
        await page.send(
            "plan-change",
            "change",
            "Please change the Plan: include a README example with a name containing spaces.",
        );
        body = await this.expect(
            (body) =>
                body.ok === true &&
                body.operation === "plan_written" &&
                action(body) === "review" &&
                Number(round(body)) > Number(firstRound),
        );
        await this.snapshot("plan-change");
        page = new ReviewPage(world.root, body);
        const changedRound = round(body);
        await page.send(
            "plan-feedback",
            "feedback",
            "Include a focused missing-name test that checks the nonzero exit and stderr usage.",
        );
        body = await this.expect(
            (body) =>
                body.ok === true &&
                body.operation === "plan_written" &&
                action(body) === "review" &&
                Number(round(body)) > Number(changedRound),
        );
        await this.snapshot("plan-feedback");
        page = new ReviewPage(world.root, body);
        await page.conversation("plan-feedback");
        await host.stop("plan-killed", "SIGKILL");
        await page.requireStopped();
        await this.snapshot("plan-killed");

        host = this.start("plan-restored", "plan-restored", "/runwield:plan-review");
        body = await this.expect(
            (body) =>
                body.ok === true &&
                body.operation === "status" &&
                action(body) === "review" &&
                typeof field(body, "review", "url") === "string",
        );
        await this.snapshot("plan-restored");
        page = new ReviewPage(world.root, body);
        await page.approve("plan-approved");
        await this.expect((body) => body.ok === true && state(body) === "plan_ready");
        await this.snapshot("plan-approved");
        await this.expect((body) => body.ok === true && state(body) === "implemented");
        await host.stop("implemented", "SIGKILL");
        const implemented = await world.snapshot("implemented", host.options.runId);
        const implementedRecord = implemented.files.find((file) => file.path.endsWith(`/workflows/${workflowId}.json`));
        const executionCwd = implementedRecord?.text
            ? field(JSON.parse(implementedRecord.text), "execution", "executionCwd")
            : undefined;
        if (typeof executionCwd !== "string") throw new Error("No execution checkout");
        await world.checkInstrumentation(executionCwd);
        world.plugin("disabled", ["disable", "runwield@runwield", "--scope", "local"]);
        await this.ordinary("disabled", "disabled", world.sentinels[2]);
        world.plugin("uninstalled", ["uninstall", "runwield@runwield", "--scope", "local"]);
        await this.ordinary("uninstalled", "uninstalled", world.sentinels[3]);
        world.plugin("reinstalled", ["install", "runwield@runwield", "--scope", "local"]);
        await world.snapshot("reinstalled", null);

        const beforeCi = await this.ciCount();
        host = this.start("validate", "ci-started", "/runwield:validate");
        await world.waitForCiStart(host, beforeCi, this.remaining());
        await world.interruptCi(host);
        host = this.start("ci-resumed", "ci-resumed", "/runwield:validate");
        await this.expect(
            (body) =>
                body.ok === true &&
                body.operation === "start_validation" &&
                field(body, "workflow", "nextAction", "request", "kind") === "reviewer",
        );
        await this.snapshot("ci-resumed");
        await this.expect(
            (body) => body.ok === true && field(body, "workflow", "nextAction", "request", "kind") === "repair",
        );
        await this.snapshot("review-blocked");
        body = await this.expect((body) => body.ok === true && action(body) === "code_review");
        await this.snapshot("code-review");
        page = new ReviewPage(world.root, body);
        await page.send("code-chat", "question", "Which checks and review findings were verified before this diff?");
        body = await this.expect((body) => page.acceptsReply(body));
        await this.snapshot("code-chat");
        page = new ReviewPage(world.root, body);
        const previousAction = field(body, "workflow", "nextAction", "actionId");
        await page.send(
            "code-change",
            "change",
            "Please change the README: add an Examples section with a greeting for Grace. Keep the command and existing checks unchanged.",
        );
        body = await this.expect(
            (body) =>
                body.ok === true &&
                action(body) === "code_review" &&
                field(body, "workflow", "nextAction", "actionId") !== previousAction,
        );
        await world.checkInstrumentation(executionCwd);
        await this.snapshot("code-change");
        page = new ReviewPage(world.root, body);
        await page.approve("code-approved");
        await this.snapshot("code-approved");
        await this.expect((body) => body.ok === true && action(body) === "delivered");
        host.resume();
        await host.finishTurn(this.remaining());
        await host.stop("delivered");
        await this.snapshot("delivered");
        await this.ordinary("inactive-after", "inactive-after", world.sentinels[4]);
    }
    private async ciCount(): Promise<number> {
        return (await readFile(join(this.world.root, "markers/ci-runs"), "utf8")).split("\n").filter(Boolean).length;
    }
}

/** Explicitly opt-in. CI imports/tests this code but never calls it with a real Claude binary. */
export async function runAcceptance(options: AcceptanceOptions): Promise<AcceptanceSummary> {
    const world = await AcceptanceWorld.create(options.root, options.checkout, options.claude);
    const journey = new Journey(world);
    const cancel = () => journey.cancel();
    const timeout = setTimeout(cancel, 90 * 60_000);
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    let prerequisite: string | null = null;
    let failed = false;
    try {
        await journey.run(await world.prepare());
    } catch (error) {
        failed = true;
        if (error instanceof PrerequisiteError) prerequisite = error.prerequisite;
        await appendFile(
            join(world.root, "logs/driver.log"),
            error instanceof Error ? `${error.stack}\n` : "Driver failed\n",
        );
    } finally {
        clearTimeout(timeout);
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
        try {
            await journey.close();
        } catch {
            world.issues.push("cleanup: host shutdown failed");
        }
        try {
            await world.close();
        } catch {
            world.issues.push("cleanup: proxy shutdown failed");
        }
    }
    try {
        await world.verifySource();
    } catch {
        world.issues.push("Core source could not be verified after acceptance");
    }
    const evidence = await collectEvidence(world.root, world.sentinels);
    if (failed) evidence.errors.push("driver: required journey did not complete");
    evidence.errors.push(...world.issues);
    const summary = evaluateEvidence(evidence);
    if (prerequisite) {
        summary.outcome = "blocked";
        summary.blockedPrerequisite = prerequisite;
        summary.proposedMatrixEntry = null;
    }
    await writeFile(join(world.root, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    if (summary.outcome === "pass" && !options.keep) await world.discardPrivateFiles();
    return summary;
}
