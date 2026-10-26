import assert from "node:assert/strict";
import { readAttempt } from "../src/attempts.ts";
import { git } from "../src/git.ts";
import { publishValidated } from "../src/publication.ts";
import { rejectPushes, withPublicationFixture } from "./git-fixture.ts";

await withPublicationFixture(async (f) => {
    const result = await publishValidated(f.repair, f.attemptFile, {
        remote: f.remote,
        targetRef: "refs/heads/main",
        candidate: f.candidate,
    });
    assert.equal(result.status, "published");
    assert.equal(result.error, null);
    assert.equal(git(f.remote, ["rev-parse", "refs/heads/main"]), result.preparedCommit);
    git(f.remote, ["merge-base", "--is-ancestor", f.candidate, result.preparedCommit]);
    assert.deepEqual(await readAttempt(f.attemptFile), result);
});
console.log("PASS normal publication records the sent candidate");

await withPublicationFixture(async (f) => {
    await rejectPushes(f, true);
    const result = await publishValidated(f.repair, f.attemptFile, {
        remote: f.remote,
        targetRef: "refs/heads/main",
        candidate: f.candidate,
    });
    assert.equal(result.status, "pending");
    assert.match(result.error ?? "", /Publication maintenance window/);
    assert.equal(result.candidate, f.candidate);
    assert.equal(git(f.remote, ["rev-parse", "refs/heads/main"]), f.initialTarget);
    assert.deepEqual(await readAttempt(f.attemptFile), result);
});
console.log("PASS remote rejection retains a pending attempt and its error");

await withPublicationFixture(async (f) => {
    await assert.rejects(
        publishValidated(f.repair, f.attemptFile, {
            remote: f.remote,
            targetRef: "refs/heads/main",
            candidate: "missing-candidate",
        }),
        /git rev-parse failed/,
    );
    assert.equal(git(f.remote, ["rev-parse", "refs/heads/main"]), f.initialTarget);
});
console.log("PASS unavailable candidates do not change the target");
