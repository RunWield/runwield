import assert from "node:assert/strict";
import { readAttempt } from "../src/attempts.ts";
import { git, gitResult } from "../src/git.ts";
import { publishValidated, retryPublication } from "../src/publication.ts";
import { advanceTarget, rejectPushes, withPublicationFixture } from "../tests/git-fixture.ts";

if (process.argv[2] !== "target-ancestry") throw new Error("Select target-ancestry");

// The helper owns all repositories and removes them in finally, including when the ancestry assertion fails.
await withPublicationFixture(async (f) => {
    await rejectPushes(f, true);
    const first = await publishValidated(f.repair, f.attemptFile, {
        remote: f.remote,
        targetRef: "refs/heads/main",
        candidate: f.candidate,
    });
    assert.equal(first.status, "pending", "The first send must be rejected");
    assert.match(first.error ?? "", /Publication maintenance window/);
    assert.deepEqual(await readAttempt(f.attemptFile), first, "Retry must start from a saved attempt");
    assert.equal(git(f.remote, ["rev-parse", "refs/heads/main"]), f.initialTarget);

    await rejectPushes(f, false);
    const advancedTarget = await advanceTarget(f);
    assert.notEqual(advancedTarget, f.initialTarget);
    assert.equal(git(f.remote, ["rev-parse", "refs/heads/main"]), advancedTarget);

    // This call reads the record from disk; it receives neither the old request nor the other writer's commit ID.
    const retried = await retryPublication(f.repair, f.attemptFile);
    assert.equal(retried.status, "published", "Retry must successfully send, not merely refuse the changed target");
    assert.equal(retried.expectedTarget, advancedTarget, "Retry must use a fresh lease");
    assert.equal(retried.candidate, f.candidate);
    const published = git(f.remote, ["rev-parse", "refs/heads/main"]);
    assert.equal(published, retried.preparedCommit);
    assert.equal(
        gitResult(f.remote, ["merge-base", "--is-ancestor", advancedTarget, published]).code,
        0,
        "RV-D10-TARGET-ANCESTRY",
    );
    assert.equal(
        gitResult(f.remote, ["merge-base", "--is-ancestor", f.candidate, published]).code,
        0,
        "The published commit must retain the validated candidate",
    );
    assert.equal(git(f.remote, ["show", `${published}:target-note.txt`]), "Independent target work");
    assert.equal(git(f.remote, ["show", `${published}:candidate.txt`]), "Validated repair");
    assert.deepEqual(await readAttempt(f.attemptFile), retried);
});
console.log("PASS target-ancestry");
