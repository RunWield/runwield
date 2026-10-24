import { bashFixturePath, quoteBashFixture } from "./bash-fixture.ts";
import { test } from "node:test";
import {
    cp as fsCp,
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { ok as assert } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../src/testing/assertions.ts";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { git } from "../src/shared/git-test-fixture.ts";
import {
    decoder,
    docsFixture,
    docsStep,
    executable,
    jobBlock,
    jobCondition,
    publishedAssets,
    repositoryRoot,
    runShell,
    stepBlock,
    stepRun,
    tag,
    write,
    type PublishedRelease,
} from "./docs-workflow-fixture.ts";

interface ReleaseState {
    cancelled: boolean;
    kind: string;
    published: string;
    ciResult: string;
    goldenResult: string;
    releaseCheckResult: string;
    buildResult: string;
    assetsResult: string;
    homebrewResult: string;
    releaseResult: string;
    nativePackageResult: string;
    unixResult: string;
    containersResult: string;
    docsResult: string;
}

function evaluateReleaseCondition(condition: string, state: ReleaseState): boolean {
    const values: Record<string, string | boolean> = {
        "!cancelled()": !state.cancelled,
        "needs.metadata.outputs.kind": state.kind,
        "needs.metadata.outputs.published": state.published,
        "needs.ci.result": state.ciResult,
        "needs.golden.result": state.goldenResult,
        "needs.release-check.result": state.releaseCheckResult,
        "needs.build.result": state.buildResult,
        "needs.assets.result": state.assetsResult,
        "needs.homebrew-check.result": state.homebrewResult,
        "needs.release.result": state.releaseResult,
        "needs.native-package-check.result": state.nativePackageResult,
        "needs.unix-checks.result": state.unixResult,
        "needs.containers-checks.result": state.containersResult,
        "needs.docs-artifact.result": state.docsResult,
    };
    let expression = condition;
    for (const [key, value] of Object.entries(values)) {
        expression = expression.replaceAll(key, JSON.stringify(value));
    }
    return Boolean(Function(`"use strict"; return (${expression});`)());
}

const successfulRelease: ReleaseState = {
    cancelled: false,
    kind: "stable",
    published: "false",
    ciResult: "success",
    goldenResult: "success",
    releaseCheckResult: "success",
    buildResult: "success",
    assetsResult: "success",
    homebrewResult: "success",
    releaseResult: "success",
    nativePackageResult: "success",
    unixResult: "success",
    containersResult: "success",
    docsResult: "success",
};

test("actual release event condition publishes only qualified Stable results", async () => {
    const workflow = await fsReadFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
    const job = jobBlock(workflow, "publish-docs");
    const condition = jobCondition(job);
    assertEquals(evaluateReleaseCondition(condition, successfulRelease), true);
    assertEquals(evaluateReleaseCondition(condition, { ...successfulRelease, kind: "candidate" }), false);
    assertEquals(evaluateReleaseCondition(condition, { ...successfulRelease, releaseResult: "failure" }), false);
    assertEquals(evaluateReleaseCondition(condition, { ...successfulRelease, cancelled: true }), false);
    assertStringIncludes(job, "actions: write");
    assertStringIncludes(job, "RELEASE_TAG: ${{ needs.metadata.outputs.tag }}");
    assertEquals(workflow.includes("uses: ./.github/workflows/docs.yml"), false);
    assertEquals(workflow.includes("github-pages"), false);
    const integration = jobBlock(workflow, "integrate-release-branch");
    assertEquals(jobCondition(integration), condition);
    assertStringIncludes(integration, "needs: [metadata, release]");
    assertStringIncludes(integration, "contents: write");
    assertStringIncludes(integration, 'run: bash scripts/integrate-release-branch.sh "$RELEASE_TAG"');
});

test("fresh and existing releases traverse the actual qualification conditions", async () => {
    const workflow = await fsReadFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
    const build = jobBlock(workflow, "build");
    const assets = jobBlock(workflow, "assets");
    const release = jobBlock(workflow, "release");
    const publish = jobBlock(workflow, "publish-docs");

    assertEquals(evaluateReleaseCondition(jobCondition(build), successfulRelease), true);
    assertEquals(evaluateReleaseCondition(jobCondition(assets), successfulRelease), true);
    assertEquals(evaluateReleaseCondition(jobCondition(release), successfulRelease), true);
    assertEquals(evaluateReleaseCondition(jobCondition(publish), successfulRelease), true);

    const recovery = { ...successfulRelease, published: "true", buildResult: "skipped" };
    assertEquals(evaluateReleaseCondition(jobCondition(build), recovery), false);
    assertEquals(evaluateReleaseCondition(jobCondition(assets), recovery), true);
    assertEquals(evaluateReleaseCondition(jobCondition(release), recovery), true);
    assertEquals(evaluateReleaseCondition(jobCondition(publish), recovery), true);
    assertStringIncludes(jobBlock(workflow, "release-check"), "needs: metadata");
    assertStringIncludes(jobBlock(workflow, "golden-shards"), "needs: metadata");
    for (const gate of ["ci", "golden"]) {
        const aggregate = jobBlock(workflow, gate);
        assertStringIncludes(aggregate, `needs: ${gate}-shards`);
        assertStringIncludes(aggregate, "if: always()");
        assertStringIncludes(aggregate, "test '${{ needs." + gate + "-shards.result }}' = 'success'");
    }
    assertStringIncludes(release, "needs.ci.result == 'success'");
    assertStringIncludes(release, "needs.golden.result == 'success'");
    assertStringIncludes(release, "needs.release-check.result == 'success'");
    assertStringIncludes(release, "needs.assets.result == 'success'");
    for (const key of [
        "ciResult",
        "goldenResult",
        "releaseCheckResult",
        "assetsResult",
        "homebrewResult",
        "nativePackageResult",
        "unixResult",
        "containersResult",
        "docsResult",
    ]) {
        for (const status of ["failure", "cancelled", "skipped"]) {
            assertEquals(
                evaluateReleaseCondition(jobCondition(release), { ...successfulRelease, [key]: status }),
                false,
            );
            assertEquals(evaluateReleaseCondition(jobCondition(release), { ...recovery, [key]: status }), false);
        }
    }
    assertEquals(
        evaluateReleaseCondition(jobCondition(assets), { ...successfulRelease, buildResult: "failure" }),
        false,
    );
    assertEquals(evaluateReleaseCondition(jobCondition(release), { ...successfulRelease, cancelled: true }), false);
});

test("published recovery prepares its bundle without rebuilding or uploading immutable docs assets", async () => {
    const workflow = await fsReadFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
    const artifact = jobBlock(workflow, "docs-artifact");
    const steps = artifact.split(/^ {12}- /m);
    const upload = steps.find((step) => step.includes("name: wld-docs\n"));
    const bundle = steps.find((step) => step.includes("name: prepared-docs\n"));
    assert(upload, "Missing qualified docs asset upload");
    assert(bundle, "Missing prepared docs bundle upload");
    for (const step of [stepBlock(artifact, "Build and package qualified documentation"), upload]) {
        const condition = jobCondition(step);
        assertEquals(evaluateReleaseCondition(condition, successfulRelease), true);
        assertEquals(evaluateReleaseCondition(condition, { ...successfulRelease, published: "true" }), false);
    }
    assertEquals(evaluateReleaseCondition(jobCondition(artifact), { ...successfulRelease, published: "true" }), true);
    assertEquals(/^\s+if:/m.test(stepBlock(artifact, "Prepare one documentation commit")), false);
    assertEquals(/^\s+if:/m.test(bundle), false);
});

for (const status of ["failure", "cancelled", "skipped"]) {
    test(`Stable publication blocks a ${status} docs artifact while Candidates can skip docs`, async () => {
        const workflow = await fsReadFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
        for (const name of ["assets", "release"]) {
            const condition = jobCondition(jobBlock(workflow, name));
            assertEquals(evaluateReleaseCondition(condition, { ...successfulRelease, docsResult: status }), false);
            assertEquals(
                evaluateReleaseCondition(condition, {
                    ...successfulRelease,
                    kind: "candidate",
                    docsResult: "skipped",
                }),
                true,
            );
        }
        assertEquals(
            evaluateReleaseCondition(jobCondition(jobBlock(workflow, "docs-artifact")), {
                ...successfulRelease,
                kind: "candidate",
            }),
            false,
        );
    });
}

for (const scenario of ["api-error", "old-tag", "other-ref", "wrong-version", "latest", "implicit-latest"]) {
    test(`production release selection handles ${scenario}`, async () => {
        const f = await docsFixture();
        try {
            const env = { ...f.env };
            if (scenario === "wrong-version") {
                await write(join(f.source, "docs-site/release.json"), JSON.stringify({ version: "v1.0.0" }));
            }
            const result = await runShell(
                await docsStep("Select latest Stable release"),
                {
                    ...env,
                    GH_MODE: scenario === "api-error" ? "api-error" : "ok",
                    REQUESTED_TAG: scenario === "old-tag" ? "v1.0.0" : scenario === "implicit-latest" ? "" : tag,
                    GITHUB_REF: scenario === "other-ref" ? "refs/heads/main" : env.GITHUB_REF,
                },
                f.source,
            );
            assertEquals(
                result.success,
                ["latest", "implicit-latest"].includes(scenario),
                decoder.decode(result.stderr),
            );
            if (scenario === "api-error") {
                assertEquals(result.code, 41);
                assertStringIncludes(decoder.decode(result.stderr), "API unavailable");
            }
            if (scenario === "old-tag")
                assertStringIncludes(decoder.decode(result.stderr), "Refusing to replace current docs");
        } finally {
            await fsRm(f.root, { recursive: true, force: true });
        }
    });
}

for (const scenario of ["api-error", "incomplete", "checksum-mismatch", "published-digest", "qualified"]) {
    test(`production asset qualification handles ${scenario} through the real checker`, async () => {
        const f = await docsFixture();
        try {
            await publishedAssets(f);
            const archive = `runwield-docs-${tag}.tar.gz`;
            if (scenario === "checksum-mismatch") await fsWriteFile(join(f.env.PUBLISHED_DIR, archive), "tampered");
            if (scenario === "published-digest") {
                const metadata: PublishedRelease = JSON.parse(await fsReadFile(f.env.PUBLISHED_METADATA, "utf8"));
                const asset = metadata.assets.find((asset) => asset.name === archive);
                assert(asset);
                asset.digest = `sha256:${"0".repeat(64)}`;
                await fsWriteFile(f.env.PUBLISHED_METADATA, JSON.stringify(metadata));
            }
            const result = await runShell(
                await docsStep("Verify documentation source and qualified release"),
                {
                    ...f.env,
                    GH_MODE: scenario,
                },
                f.source,
            );
            assertEquals(result.success, scenario === "qualified", decoder.decode(result.stderr));
            const errors: Record<string, string> = {
                "api-error": "API unavailable",
                incomplete: "Expected one",
                "checksum-mismatch": "Release checksum mismatch",
                "published-digest": "Published asset digest",
            };
            if (scenario !== "qualified") assertStringIncludes(decoder.decode(result.stderr), errors[scenario]);
            else
                assertEquals(
                    await fsReadFile(join(f.root, "verified-docs-release", archive)),
                    await fsReadFile(join(f.env.PUBLISHED_DIR, archive)),
                );
        } finally {
            await fsRm(f.root, { recursive: true, force: true });
        }
    });
}

test("matching dispatched docs assets deploy the exact qualified bytes without rebuilding", async () => {
    const f = await docsFixture();
    try {
        await publishedAssets(f);
        const qualified = await runShell(
            await docsStep("Verify documentation source and qualified release"),
            f.env,
            f.source,
        );
        assert(qualified.success, decoder.decode(qualified.stderr));
        const selected = await runShell(await docsStep("Select qualified documentation bytes"), f.env, f.source);
        assert(selected.success, decoder.decode(selected.stderr));
        assertEquals(await fsReadFile(f.env.GITHUB_OUTPUT, "utf8"), "rebuild=false\n");
        assertEquals(await fsReadFile(join(f.source, "dist/docs/index.html"), "utf8"), "QUALIFIED-ARCHIVE-BYTES\n");
        assertEquals(
            await fsReadFile(join(f.source, "dist/docs/release.json")),
            await fsReadFile(join(f.root, "archive/release.json")),
        );
        const workflow = await fsReadFile(join(repositoryRoot, ".github/workflows/docs.yml"), "utf8");
        assertStringIncludes(workflow, "if: steps.asset.outputs.rebuild == 'true'");
        assertStringIncludes(workflow, "path: source/dist/docs");
    } finally {
        await fsRm(f.root, { recursive: true, force: true });
    }
});

test("pushed corrections cannot reuse the release archive", async () => {
    const f = await docsFixture();
    try {
        await publishedAssets(f);
        const verified = await runShell(
            await docsStep("Verify documentation source and qualified release"),
            f.env,
            f.source,
        );
        assert(verified.success, decoder.decode(verified.stderr));
        const selected = await runShell(
            await docsStep("Select qualified documentation bytes"),
            { ...f.env, EVENT_NAME: "push" },
            f.source,
        );
        assert(selected.success, decoder.decode(selected.stderr));
        assertEquals(await fsReadFile(f.env.GITHUB_OUTPUT, "utf8"), "rebuild=true\n");
    } finally {
        await fsRm(f.root, { recursive: true, force: true });
    }
});

for (const scenario of ["current", "new-release", "new-correction", "api-error"]) {
    test(`predeployment freshness check handles ${scenario}`, async () => {
        const f = await docsFixture();
        try {
            if (scenario === "new-correction") {
                const correction = join(f.root, "correction");
                await git(f.root, ["clone", "--branch", "docs/stable", f.remote, correction]);
                await git(correction, ["config", "user.name", "Test"]);
                await git(correction, ["config", "user.email", "test@example.test"]);
                await write(join(correction, "docs-site/correction.txt"), "New correction");
                await git(correction, ["add", "."]);
                await git(correction, ["-c", "commit.gpgsign=false", "commit", "-m", "New correction"]);
                await git(correction, ["push", "origin", "HEAD:docs/stable"]);
            }
            const result = await runShell(
                await docsStep("Reject stale build before deployment"),
                {
                    ...f.env,
                    LATEST_TAG: scenario === "new-release" ? "v3.0.0" : tag,
                    GH_MODE: scenario,
                },
                f.source,
            );
            assertEquals(result.success, scenario === "current", decoder.decode(result.stderr));
            if (scenario === "new-release") assertStringIncludes(decoder.decode(result.stderr), "became stale");
            if (scenario === "new-correction")
                assertStringIncludes(decoder.decode(result.stderr), "Documentation source is stale");
            if (scenario === "api-error") {
                assertEquals(result.code, 41);
                assertStringIncludes(decoder.decode(result.stderr), "API unavailable");
            }
        } finally {
            await fsRm(f.root, { recursive: true, force: true });
        }
    });
}

test("docs workflow retains source checks and isolates historical source from frozen tooling", async () => {
    const workflow = await fsReadFile(join(repositoryRoot, ".github/workflows/docs.yml"), "utf8");
    const deploy = jobBlock(workflow, "deploy");
    assertEquals(workflow.includes("workflow_call"), false);
    assertEquals(workflow.includes("git push"), false);
    assertStringIncludes(deploy, "if: github.ref == 'refs/heads/docs/stable'");
    assertStringIncludes(workflow, "group: runwield-docs-pages");
    assertStringIncludes(workflow, "cancel-in-progress: false");
    assertEquals(deploy.includes("deno"), false);
    assertStringIncludes(deploy, "ref: ${{ github.sha }}");
    assertStringIncludes(deploy, "path: source");
    assertStringIncludes(deploy, "path: tooling");
    assertStringIncludes(stepBlock(deploy, "Checkout Bun documentation tooling"), "submodules: recursive");
    assertStringIncludes(deploy, "ref: ${{ github.event.repository.default_branch }}");
    assertStringIncludes(deploy, "bun-version-file: tooling/.bun-version");
    assertStringIncludes(deploy, "working-directory: tooling");
    assertStringIncludes(deploy, "bun run install:locked");
    assertStringIncludes(deploy, "bun tooling/scripts/build-stable-docs.ts source");
    assertStringIncludes(deploy, "path: source/dist/docs");
    for (const step of ["Verify documentation source and qualified release", "Reject stale build before deployment"]) {
        const stepStart = deploy.indexOf(`            - name: ${step}\n`);
        const stepBody = deploy.slice(stepStart).split(/\n {12}- /)[0];
        assertStringIncludes(stepBody, "working-directory: source");
        assertStringIncludes(stepRun(deploy, step), "bun ../tooling/scripts/verify-docs-source.ts");
        assertStringIncludes(stepRun(deploy, step), "git rev-parse HEAD");
    }
    assertEquals(
        deploy.lastIndexOf("scripts/verify-docs-source.ts") < deploy.indexOf("uses: actions/deploy-pages@v4"),
        true,
    );
    assertStringIncludes(workflow, "isPrerelease == false and .isDraft == false");
});

for (const scenario of ["one-parent correction", "legacy metadata"]) {
    test(`Stable docs full publication retry reuses the ${scenario} tip without new commits`, async () => {
        const f = await docsFixture();
        try {
            await write(join(f.source, "docs-site/retry-correction.txt"), "Keep the published correction\n");
            if (scenario === "legacy metadata") {
                await write(
                    join(f.source, "docs-site/release.json"),
                    JSON.stringify({ version: tag, sourceRef: f.sha }),
                );
            }
            await git(f.source, ["add", "."]);
            await git(f.source, ["commit", "-m", "Correct the published Stable manual"]);
            const corrected = await git(f.source, ["rev-parse", "HEAD"]);
            assertEquals(await git(f.source, ["show", "-s", "--format=%P", corrected]), f.sha);
            await git(f.source, ["push", "origin", "HEAD:docs/stable"]);
            const count = await git(f.remote, ["rev-list", "--all", "--count"]);
            const metadata = await fsReadFile(join(f.source, "docs-site/release.json"), "utf8");
            assertEquals(JSON.parse(metadata).sourceRef, scenario === "legacy metadata" ? f.sha : f.releaseSha);
            await git(f.source, ["checkout", "--detach", f.releaseSha]);
            const workflow = await fsReadFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
            const prepared = await runShell(
                stepRun(jobBlock(workflow, "docs-artifact"), "Prepare one documentation commit"),
                { ...f.env, RELEASE_TAG: tag },
                f.source,
            );
            assert(prepared.success, decoder.decode(prepared.stdout) + decoder.decode(prepared.stderr));
            assertEquals((await fsReadFile(f.env.GITHUB_OUTPUT, "utf8")).trim(), `sha=${corrected}`);
            assertEquals(await git(f.source, ["rev-list", "--all", "--count"]), count);
            const receiver = join(f.root, "receiver");
            await git(f.root, ["clone", f.remote, receiver]);
            await fsMkdir(join(receiver, "prepared-docs"));
            await fsCp(join(f.root, "prepared-docs.bundle"), join(receiver, "prepared-docs/prepared-docs.bundle"));
            await fsCp(
                join(repositoryRoot, "scripts/reconcile-docs-branch.sh"),
                join(receiver, "scripts/reconcile-docs-branch.sh"),
            );
            const published = await runShell(
                stepRun(jobBlock(workflow, "publish-docs"), "Publish prepared documentation commit"),
                { ...f.env, RELEASE_TAG: tag, DOCS_SHA: corrected },
                receiver,
            );
            assert(published.success, decoder.decode(published.stdout) + decoder.decode(published.stderr));
            assertEquals(await git(f.remote, ["rev-parse", "refs/heads/docs/stable"]), corrected);
            assertEquals(await git(f.remote, ["rev-list", "--all", "--count"]), count);
            assertEquals(await git(receiver, ["rev-list", "--all", "--count"]), count);
            assertEquals(await git(f.remote, ["show", `${corrected}:docs-site/release.json`]), metadata.trim());
            assertEquals(
                await git(f.remote, ["show", `${corrected}:docs-site/retry-correction.txt`]),
                "Keep the published correction",
            );
        } finally {
            await fsRm(f.root, { recursive: true, force: true });
        }
    });
}

for (const scenario of ["prepared", "retry", "arriving-correction", "push-time-correction"]) {
    test(`Stable docs publication preserves the remote branch for ${scenario}`, async () => {
        const f = await docsFixture();
        try {
            const releaseTag = "v2.0.1";
            await git(f.source, ["checkout", "--detach", f.releaseSha]);
            await write(join(f.source, "docs-site/new-release.txt"), "Stable release content\n");
            await git(f.source, ["add", "."]);
            await git(f.source, ["commit", "-m", "Next Stable"]);
            const releaseSha = await git(f.source, ["rev-parse", "HEAD"]);
            await git(f.source, ["tag", releaseTag]);
            await git(f.source, ["push", "origin", "--tags"]);
            const prepare = await runShell(
                `bash ${quoteBashFixture(bashFixturePath(join(repositoryRoot, "scripts/reconcile-docs-branch.sh")))} ${releaseTag}`,
                f.env,
                f.source,
            );
            assert(prepare.success, decoder.decode(prepare.stderr));
            const prepared = decoder.decode(prepare.stdout).trim();
            await git(f.source, ["update-ref", "refs/docs/prepared", prepared]);
            await fsMkdir(join(f.source, "prepared-docs"));
            await git(f.source, [
                "bundle",
                "create",
                "prepared-docs/prepared-docs.bundle",
                "refs/docs/prepared",
                `^${releaseTag}`,
            ]);
            let previousTip = f.sha;
            if (scenario === "retry") await git(f.source, ["push", "origin", `${prepared}:docs/stable`]);
            if (["arriving-correction", "push-time-correction"].includes(scenario)) {
                const correction = join(f.root, "correction");
                await git(f.root, ["clone", "--branch", "docs/stable", f.remote, correction]);
                await git(correction, ["config", "user.name", "Test"]);
                await git(correction, ["config", "user.email", "test@example.test"]);
                await write(join(correction, "docs-site/arriving-correction.txt"), "Preserve this correction\n");
                await git(correction, ["add", "."]);
                await git(correction, ["-c", "commit.gpgsign=false", "commit", "-m", "Arriving correction"]);
                previousTip = await git(correction, ["rev-parse", "HEAD"]);
                if (scenario === "arriving-correction") {
                    await git(correction, ["push", "origin", "HEAD:docs/stable"]);
                } else {
                    // Git runs pre-push after it has read the remote advertisement.
                    // Advance the real remote now, not during the workflow preflight.
                    const marker = quoteBashFixture(bashFixturePath(join(f.root, "push-race")));
                    await executable(
                        join(f.source, ".git/hooks/pre-push"),
                        `#!/usr/bin/env bash
set -euo pipefail
[[ ! -f ${marker} ]] || exit 0
while read -r local_ref local_sha remote_ref remote_sha; do
  if [[ "$remote_ref" == refs/heads/docs/stable ]]; then
    test "$remote_sha" = "${f.sha}"
    printf '%s\\n' "$remote_sha" > ${marker}
    git -C ${quoteBashFixture(bashFixturePath(correction))} push origin HEAD:refs/heads/docs/stable
  fi
done
`,
                    );
                }
            }
            const workflow = await fsReadFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
            const command = stepRun(jobBlock(workflow, "publish-docs"), "Publish prepared documentation commit");
            await fsCp(
                join(repositoryRoot, "scripts/reconcile-docs-branch.sh"),
                join(f.source, "scripts/reconcile-docs-branch.sh"),
            );
            const published = await runShell(
                command,
                {
                    ...f.env,
                    RELEASE_TAG: releaseTag,
                    LATEST_TAG: releaseTag,
                    DOCS_SHA: prepared,
                },
                f.source,
            );
            assert(published.success, decoder.decode(published.stdout) + decoder.decode(published.stderr));
            const tip = await git(f.remote, ["rev-parse", "refs/heads/docs/stable"]);
            assertEquals(await git(f.remote, ["show", "-s", "--format=%P", tip]), `${releaseSha} ${previousTip}`);
            assertEquals(await git(f.remote, ["rev-list", "--count", tip, `^${releaseSha}`, `^${previousTip}`]), "1");
            if (!["arriving-correction", "push-time-correction"].includes(scenario)) assertEquals(tip, prepared);
            else
                assertEquals(
                    await git(f.remote, ["show", `${tip}:docs-site/arriving-correction.txt`]),
                    "Preserve this correction",
                );
            if (scenario === "push-time-correction") {
                assertEquals((await fsReadFile(join(f.root, "push-race"), "utf8")).trim(), f.sha);
                assertStringIncludes(decoder.decode(published.stderr), "failed to push some refs");
            }
            assertEquals(command.includes("--force"), false);
        } finally {
            await fsRm(f.root, { recursive: true, force: true });
        }
    });
}

for (const scenario of ["success", "deployment-failure", "dispatch-failure", "lookup-failure"]) {
    test(`release dispatch correlates its own docs run and handles ${scenario}`, async () => {
        const root = await fsMkdtemp(join(tmpdir(), "runwield-docs-dispatch-"));
        try {
            const bin = join(root, "bin");
            await fsMkdir(bin);
            await executable(
                join(bin, "gh"),
                `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "workflow run") [[ "$GH_MODE" != dispatch-failure ]] || exit 41 ;;
  "run list")
    [[ "$GH_MODE" != lookup-failure ]] || exit 42
    # A broad lookup returns unrelated correction/retry runs as GitHub does.
    if [[ "$*" == *'select(.displayTitle == "docs v2.0.0 123-2")'* ]]; then echo 991;
    else printf '990\\n991\\n992\\n'; fi ;;
  "run watch")
    [[ "$3" == 991 && "$*" == *--exit-status* ]] || exit 44
    [[ "$GH_MODE" != deployment-failure ]] || exit 43 ;;
  *) exit 99 ;;
esac
`,
            );
            const workflow = await fsReadFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
            const command = stepRun(jobBlock(workflow, "publish-docs"), "Dispatch and await documentation deployment");
            const log = join(root, "gh.log");
            const result = await runShell(
                command,
                {
                    PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
                    GH_LOG: log,
                    GH_MODE: scenario,
                    RELEASE_TAG: tag,
                    GITHUB_RUN_ID: "123",
                    GITHUB_RUN_ATTEMPT: "2",
                },
                root,
            );
            assertEquals(result.success, scenario === "success", decoder.decode(result.stderr));
            const calls = await fsReadFile(log, "utf8");
            assertStringIncludes(calls, "workflow run docs.yml --ref docs/stable -f tag=v2.0.0 -f request=123-2");
            if (scenario === "success" || scenario === "deployment-failure") {
                assertStringIncludes(
                    calls,
                    "run list --workflow docs.yml --event workflow_dispatch --branch docs/stable",
                );
                assertStringIncludes(calls, "run watch 991 --exit-status --interval 15");
            }
        } finally {
            await fsRm(root, { recursive: true, force: true });
        }
    });
}

test("release source resolution pins the product runtime and bounds historical compatibility to manual recovery", async () => {
    const workflow = await fsReadFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
    const command = stepRun(jobBlock(workflow, "metadata"), "Resolve the immutable product commit");
    const root = await fsMkdtemp(join(tmpdir(), "runwield-release-source-"));
    try {
        const bin = join(root, "bin");
        await fsMkdir(bin);
        await executable(
            join(bin, "git"),
            `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  fetch) exit "\${FETCH_EXIT:-0}" ;;
  rev-parse) echo "$PRODUCT_SHA"; exit "\${RESOLVE_EXIT:-0}" ;;
  show) echo 1.4.3; exit "\${PIN_EXIT:-0}" ;;
  *) exit 99 ;;
esac
`,
        );
        const output = join(root, "output");
        const base = {
            PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
            GITHUB_OUTPUT: output,
            RELEASE_TAG: "v0.12.0-rc.1",
            PRODUCT_SHA: "55cc60ec1cf5a96eeb41c9fddd12459200101aab",
            RECOVERY: "true",
        };
        for (const [recovery, sha, legacy] of [
            ["true", base.PRODUCT_SHA, "true"],
            ["false", base.PRODUCT_SHA, "false"],
            ["true", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "false"],
        ]) {
            await fsWriteFile(output, "");
            const result = await runShell(command, { ...base, RECOVERY: recovery, PRODUCT_SHA: sha });
            assert(result.success, new TextDecoder().decode(result.stderr));
            assertEquals(
                await fsReadFile(output, "utf8"),
                `sha=${sha}\nbun_version=1.4.3\nlegacy_containers=${legacy}\n`,
            );
        }
        for (const failure of ["FETCH_EXIT", "RESOLVE_EXIT", "PIN_EXIT"]) {
            const result = await runShell(command, { ...base, [failure]: "42" });
            assertEquals(result.success, false, `${failure} must stop the release`);
        }
    } finally {
        await fsRm(root, { recursive: true });
    }
});

for (const extension of ["js", "ts"]) {
    test(`release recovery runs Golden preparation from ${extension} product source`, async () => {
        const root = await fsMkdtemp(join(tmpdir(), "runwield-golden-compat-"));
        try {
            const workflow = await fsReadFile(join(repositoryRoot, ".github/workflows/release.yml"), "utf8");
            const command = stepRun(jobBlock(workflow, "golden-shards"), "Run Golden TUI release gate");
            await write(join(root, `scripts/write-version.${extension}`), 'console.log("VERSION-PREPARED");\n');
            await write(join(root, "scripts/run-tests.js"), 'console.log("GOLDEN-RUN", ...process.argv.slice(2));\n');
            const result = await runShell(command, {}, root);
            assertEquals(result.code, 0, decoder.decode(result.stderr));
            const output = decoder.decode(result.stdout);
            assertStringIncludes(output, "VERSION-PREPARED\nGOLDEN-RUN --isolated");
            assertStringIncludes(output, "src/ui/tui/testing src/ui/tui/golden-scenarios --fail-fast");
        } finally {
            await fsRm(root, { recursive: true });
        }
    });

    test(`release recovery builds container bundles from ${extension} product source`, async () => {
        const root = await fsMkdtemp(join(tmpdir(), "runwield-container-compat-"));
        try {
            const workflow = await fsReadFile(join(repositoryRoot, ".github/workflows/release-containers.yml"), "utf8");
            const command = stepRun(workflow, "Build remote runtime bundles");
            await write(join(root, "scripts/build-workspace-runtime.ts"), 'console.log("WORKSPACE-BUILT");\n');
            await write(
                join(root, `scripts/build-plan-server-runtime.${extension}`),
                'console.log("PLAN-SERVER-BUILT");\n',
            );
            const result = await runShell(command, {}, root);
            assertEquals(result.code, 0, decoder.decode(result.stderr));
            assertEquals(decoder.decode(result.stdout).trim(), "WORKSPACE-BUILT\nPLAN-SERVER-BUILT");
        } finally {
            await fsRm(root, { recursive: true });
        }
    });
}
