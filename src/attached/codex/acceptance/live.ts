import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ReviewPage } from "../../claude/acceptance/review.ts";
import { AcceptanceWorld, PrerequisiteError } from "./world.ts";
import { field, type AcceptanceSummary } from "./evidence.ts";
import {
    collectEvidence,
    assessHandshake,
    assessHostReview,
    assessDurableArtifacts,
    delivered,
    hostedReview,
} from "./collector.ts";
import type { AcceptanceOptions } from "./driver.ts";

const FEATURE =
    "Add sh ./greet.sh NAME: print Hello, NAME!, preserve names with spaces, and reject a missing name with nonzero exit plus usage on stderr. Add a README usage example and focused tests. Keep check.sh unchanged. Use an isolated RunWield worktree and default Plan Branch delivery. The verification command is sh ./check.sh. Browser decisions will come from the review page. If interrupted validation offers retry, choose retry and continue. Repair until success. Do not ask the harness to operate RunWield internals.";

/** Real ephemeral Codex model/worker turns; native installation is qualified separately. */
export async function runLiveAcceptance(options: AcceptanceOptions): Promise<AcceptanceSummary> {
    const world = new AcceptanceWorld(options);
    await world.create();
    const summary: AcceptanceSummary = {
        schemaVersion: 1,
        outcome: "blocked",
        scope: "source-skill",
        surface: "desktop-runtime",
        hostVersion: null,
        permissions: "full-access-in-disposable-world",
        testDate: new Date().toISOString(),
        source: null,
        adapterVersion: null,
        adapterContract: null,
        blockedPrerequisite: null,
        checks: [],
        limitations: [
            "Existing-auth ephemeral Codex app-server with explicit packaged skill path and package MCP configuration; installed discovery is qualified separately.",
            "No desktop UI claim. No tested-version entry until full independent review and recovery evidence is qualified.",
            "Full access is restricted by the acceptance instructions to disposable repositories; Core receives no host provider credentials.",
        ],
        proposedMatrixEntry: null,
    };
    let prepared = false;
    let checkpoint = "preparation";
    const record = (id: string, detail: string) => summary.checks.push({ id, outcome: "pass", detail });
    try {
        Object.assign(summary, await world.prepare());
        prepared = true;
        await world.prepareLive();
        const skill = join(world.root, "marketplace/src/attached/codex/plugin/skills/run/SKILL.md");
        await readFile(skill, "utf8");
        const invoke = (task: string) =>
            `Use $runwield:run. Its exact packaged skill file is ${skill}. Read and follow that file. Work only in the disposable fixture ${world.fixture} and RunWield's returned execution checkout. ${task}`;
        checkpoint = "ordinary request";
        let host = await world.liveHost(
            "ordinary",
            `Ordinary message: ${world.sentinel}. Reply with a short greeting. Use no tools and write no files.`,
        );
        await host.finishTurn(120_000);
        await host.stop();
        await world.snapshot("inactive-before", "ordinary");
        record("ordinary-request", "A real Codex turn completed without explicitly invoking RunWield.");
        checkpoint = "planning";
        host = await world.liveHost("request", invoke(FEATURE));
        let state = await host.waitForCore((result) => hostedReview(result, "review"), 15 * 60_000);
        await world.snapshot("plan-review", "request");
        record("skill-planning", "The packaged skill reached a Core-hosted Plan review through real Codex MCP calls.");
        await host.stop();
        checkpoint = "review restoration";
        host = await world.liveHost("restored", invoke(`Resume the latest open workflow. ${FEATURE}`));
        state = await host.waitForCore((result) => hostedReview(result, "review"), 10 * 60_000);
        await world.snapshot("plan-restored", "restored");
        record("skill-restoration", "A fresh Codex process restored the pending browser review.");
        checkpoint = "browser Plan review chat";
        const page = new ReviewPage(world.root, state);
        await page.send("plan-chat", "question", "What does the validation command check?");
        await host.waitForCore((result) => page.acceptsReply(result), 10 * 60_000);
        record("plan-review-chat", "Codex answered the queued browser review question through Core.");
        checkpoint = "implementation";
        await page.approve("plan-approved");
        state = await host.waitForCore(
            (result) =>
                result.ok === true &&
                result.operation === "task_completed" &&
                field(result, "workflow", "state") === "implemented",
            20 * 60_000,
        );
        await world.snapshot("implemented", "restored");
        record("implementation", "Codex submitted completed work through Core's task completion operation.");
        checkpoint = "validation process loss";
        const deadline = Date.now() + 5 * 60_000;
        let ciStarted = false;
        while (Date.now() < deadline) {
            if ((await readFile(join(world.root, "markers/ci-runs"), "utf8")).trim()) {
                ciStarted = true;
                break;
            }
            await delay(200);
        }
        if (!ciStarted) throw new Error("Core did not start the configured validation command");
        await world.snapshot("ci-started", "restored");
        const runningPid = Number(
            (await readFile(join(world.root, "markers/ci-runs"), "utf8")).trim().split(/\r?\n/).at(-1),
        );
        if (!Number.isSafeInteger(runningPid) || runningPid <= 0) throw new Error("Missing CI process identity");
        await host.stop();
        const cancelledDeadline = Date.now() + 10_000;
        let cancelled = false;
        while (Date.now() < cancelledDeadline) {
            try {
                process.kill(runningPid, 0);
            } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ESRCH") {
                    cancelled = true;
                    break;
                }
                throw error;
            }
            await delay(100);
        }
        if (!cancelled) throw new Error("Interrupted CI survived host shutdown");
        await world.snapshot("ci-killed", "restored");
        record("ci-process-loss", "Host shutdown cancelled the observed CI process before restoration.");
        checkpoint = "validation recovery";
        host = await world.liveHost(
            "validation-resumed",
            invoke(`Resume the latest open workflow through validation and delivery. ${FEATURE}`),
        );
        state = await host.waitForCore((result) => hostedReview(result, "code_review"), 25 * 60_000);
        await world.snapshot("code-review", "validation-resumed");
        record("validation-recovery", "Core recovered interrupted validation and reached its Code Review gate.");
        checkpoint = "publication";
        const codePage = new ReviewPage(world.root, state);
        await codePage.approve("code-approved");
        await host.waitForCore(delivered, 15 * 60_000);
        await world.snapshot("delivered", "validation-resumed");
        await host.stop();
        record("publication", "Core returned its delivered action after browser Code Review approval.");
        const evidence = await collectEvidence(world.root);
        summary.checks.push(assessHandshake(evidence, summary.hostVersion ?? ""), assessHostReview(evidence));
        summary.checks.push(...(await assessDurableArtifacts(world.root)));
        const privacy = await world.privacy();
        summary.checks.push({
            id: "privacy",
            outcome: privacy.leaks.length || privacy.errors.length ? "fail" : "pass",
            detail: "Ordinary transcript sentinels are checked against durable artifacts and Git history.",
        });
        // Incomplete host provenance is an explicit qualification gap, never a passing full journey.
        summary.outcome = summary.checks.some((check) => check.outcome === "fail")
            ? "fail"
            : summary.checks.some((check) => check.outcome === "unproven")
              ? "blocked"
              : "pass";
        if (summary.outcome === "blocked") summary.blockedPrerequisite = "independent-review-provenance";
    } catch (error) {
        summary.outcome = error instanceof PrerequisiteError ? "blocked" : "fail";
        summary.blockedPrerequisite = error instanceof PrerequisiteError ? error.prerequisite : null;
        summary.checks.push({
            id: "live-journey",
            outcome: "fail",
            detail:
                error instanceof PrerequisiteError
                    ? error.message
                    : `The real Codex skill journey stopped at ${checkpoint}. No passing qualification is claimed.`,
        });
    } finally {
        await world.close();
    }
    if (prepared && !(await world.sourceUnchanged())) {
        summary.outcome = "fail";
        summary.checks.push({
            id: "source-stability",
            outcome: "fail",
            detail: "The tested source changed during the journey.",
        });
    }
    await writeFile(join(world.root, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
    if (summary.outcome === "pass" && !options.keep) await world.discardPrivateFiles();
    return summary;
}
