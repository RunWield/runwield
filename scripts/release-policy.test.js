import { test } from "node:test";
import { readFile as fsReadFile } from "node:fs/promises";
import { match as assertMatch } from "node:assert/strict";
import { assertEquals, assertStringIncludes } from "../src/testing/assertions.ts";

test("release prompt starts with the three release choices before policy discovery", async () => {
    const prompt = await fsReadFile(new URL("../src/prompt-templates/release.md", import.meta.url), "utf8");
    const choiceIndex = prompt.indexOf("What kind of release operation should I run?");
    const discoveryIndex = prompt.indexOf("Discover the repository's release policy");

    assertEquals(choiceIndex >= 0, true);
    assertEquals(discoveryIndex > choiceIndex, true);
    assertStringIncludes(prompt, "Create Candidate");
    assertStringIncludes(prompt, "Promote Candidate");
    assertStringIncludes(prompt, "Create Stable Directly");
    assertStringIncludes(prompt, "agent: engineer");
    assertStringIncludes(prompt, "You are running inside the RunWield harness");
    assertStringIncludes(prompt, "Follow repository-specific policy first");
    assertMatch(prompt, /If no repository-specific release-note scope is\s+documented/);
    assertStringIncludes(prompt, "RunWield fallback format");
    assertStringIncludes(prompt, "make notes cumulative from the previous Stable");
    assertStringIncludes(prompt, "validation-relevant changes since the prior Candidate");
    assertStringIncludes(prompt, "shared Candidate source commit");
    assertStringIncludes(prompt, "empty release");
    assertStringIncludes(prompt, "When the repository policy says CI creates the host release");
    assertStringIncludes(prompt, "source selected by the repository's policy");
    assertStringIncludes(prompt.replace(/\s+/g, " "), "Do not introduce branch rules that its policy does not define");
    assertEquals(prompt.includes("release/vX.Y.Z"), false);
    assertEquals(prompt.includes("tools:"), false);
});

test("wld release policy distinguishes repository-specific policy from generic wld usage", async () => {
    const policy = await fsReadFile(new URL("../docs/releasing.md", import.meta.url), "utf8");

    assertStringIncludes(policy, "This document is wld's release policy");
    assertStringIncludes(policy, "wld users releasing other repositories");
    assertMatch(policy, /repository's\s+release policy and automation/);
    assertStringIncludes(policy, "The Candidate tag is the canonical source reference");
    assertStringIncludes(policy, "Do not store a duplicate source commit hash");
    assertStringIncludes(policy, "Promoted-From: <candidate-tag>");
    assertStringIncludes(
        policy.replace(/\s+/g, " "),
        "must not call `gh release create`, `gh release edit`, `glab release create`, or `glab release edit`",
    );
    assertStringIncludes(policy, "bash install.sh vX.Y.Z-rc.N");
    assertStringIncludes(policy, "gh auth status");
    assertStringIncludes(policy, "permission to read releases before tagging");
    assertStringIncludes(policy, "`release/vMAJOR.MINOR.PATCH` as its Release Branch");
    assertStringIncludes(policy, "Later Candidates resolve the live pushed Release Branch from `origin`");
    assertStringIncludes(policy, "Never merge `main` into an active Release Branch");
    assertStringIncludes(policy.replace(/\s+/g, " "), "explicitly forward-port the fix to `main`");
    assertStringIncludes(policy, "This fixed list does not grow automatically");
});

test("release workflow keeps tag publication and manual recovery channel-safe", async () => {
    const workflow = await fsReadFile(".github/workflows/release.yml", "utf8");

    assertStringIncludes(workflow, "workflow_dispatch:");
    assertMatch(workflow, /workflow_dispatch:[\s\S]*tag:[\s\S]*required: true/);
    assertStringIncludes(workflow, "RELEASE_TAG: ${{ inputs.tag || github.ref_name }}");
    assertStringIncludes(
        workflow.slice(workflow.indexOf("    metadata:"), workflow.indexOf("    ci-shards:")),
        "ref: ${{ github.sha }}",
    );
    assertMatch(workflow, /release-check:[\s\S]*ref: \$\{\{ needs\.metadata\.outputs\.source_sha \}\}/);
    assertMatch(workflow, /build:[\s\S]*ref: \$\{\{ needs\.metadata\.outputs\.source_sha \}\}/);
    assertMatch(workflow, /release:[\s\S]*ref: \$\{\{ needs\.metadata\.outputs\.source_sha \}\}/);
    assertStringIncludes(workflow, "bun run release:metadata --tag");
    assertStringIncludes(workflow, "WLD_BUILD_VERSION");
    assertStringIncludes(workflow, "prerelease: ${{ needs.metadata.outputs.prerelease }}");
    assertStringIncludes(workflow, "make_latest: ${{ needs.metadata.outputs.make_latest }}");
    assertStringIncludes(workflow, "preserve_order: true");
    assertStringIncludes(workflow, "overwrite_files: false");
    assertStringIncludes(workflow, "config.schema.json");
    assertStringIncludes(workflow, "release-upload/*");
    assertStringIncludes(workflow, "scripts/release-assets.js");
    assertStringIncludes(workflow, "wld-${VERSION}-${{ matrix.asset_suffix }}");

    const policy = await fsReadFile("docs/releasing.md", "utf8");
    assertStringIncludes(policy, "required-tag manual dispatch solely for recovery");
    assertStringIncludes(
        policy.replace(/\s+/g, " "),
        "Never use manual recovery to bypass a genuine failure in tagged product source",
    );
});

test("release publication requires native Windows package qualification", async () => {
    const workflow = await fsReadFile(".github/workflows/release.yml", "utf8");
    const windowsJob = workflow.match(/\n[ ]{4}windows-package-check:\n([\s\S]*?)\n[ ]{4}release:/)?.[1] || "";
    const releaseJob = workflow.match(/\n[ ]{4}release:\n([\s\S]*)$/)?.[1] || "";

    assertEquals(windowsJob.includes("if: ${{ false }}"), false);
    assertStringIncludes(windowsJob, "runs-on: windows-latest");
    assertStringIncludes(windowsJob, "bun run package:windows:check --package");
    assertMatch(releaseJob, /needs:[\s\S]*- windows-package-check/);
});

test("WinGet submission stays disabled while Stable manifest preparation remains active", async () => {
    const workflow = await fsReadFile(".github/workflows/release.yml", "utf8");
    const submitStart = workflow.indexOf("    winget-submit:");
    const submitEnd = workflow.indexOf("\n    homebrew-package:", submitStart);
    const submitJob = workflow.slice(submitStart, submitEnd);

    assertEquals(submitStart >= 0, true);
    assertEquals(submitEnd > submitStart, true);
    assertStringIncludes(
        workflow,
        "ref: ${{ github.event_name == 'workflow_dispatch' && github.sha || needs.metadata.outputs.source_sha }}",
    );
    assertMatch(submitJob, /\n {8}if: \$\{\{ false \}\}\n/);
    const packageJob = workflow.slice(workflow.indexOf("    winget-package:"), submitStart);
    assertStringIncludes(packageJob, "needs.metadata.outputs.kind == 'stable'");
    assertStringIncludes(packageJob, "bun run package:winget");
    const qualification = workflow.slice(workflow.indexOf("    homebrew-check:"), workflow.indexOf("    release:"));
    assertEquals(qualification.includes("WINGET_CREATE_GITHUB_TOKEN"), false);
    assertStringIncludes(submitJob, "- winget-package");
    assertStringIncludes(submitJob, "WINGET_CREATE_GITHUB_TOKEN: ${{ secrets.WINGET_CREATE_GITHUB_TOKEN }}");
    assertStringIncludes(submitJob, "wingetcreate.exe");
    assertStringIncludes(submitJob, "manifests/g/Gandazgul/RunWield/$version");
    assertStringIncludes(submitJob, "is:pr is:open in:title");
    assertStringIncludes(submitJob, "submit $manifestPath --prtitle $prTitle --no-open");
    assertEquals(submitJob.includes("submit $manifestPath --token"), false);
});

test("Stable releases validate on macOS before publishing the Homebrew tap", async () => {
    const workflow = await fsReadFile(".github/workflows/release.yml", "utf8");
    const jobStart = workflow.indexOf("    homebrew-package:");
    const job = workflow.slice(jobStart);
    const dependencyTapIndex = job.indexOf("brew tap 1broseidon/tap");
    const checkIndex = job.indexOf("bun run package:homebrew:check --tap homebrew-tap");
    const pushIndex = job.indexOf("git push origin HEAD:main");

    assertEquals(jobStart >= 0, true);
    assertStringIncludes(job, "runs-on: macos-15");
    assertStringIncludes(job, "needs.metadata.outputs.kind == 'stable'");
    assertStringIncludes(job, "repository: gandazgul/homebrew-tap");
    assertStringIncludes(job, "token: ${{ secrets.HOMEBREW_TAP_TOKEN }}");
    assertStringIncludes(job, "HOMEBREW_TAP_TOKEN: ${{ secrets.HOMEBREW_TAP_TOKEN }}");
    assertEquals(dependencyTapIndex >= 0, true);
    assertEquals(checkIndex > dependencyTapIndex, true);
    assertEquals(pushIndex > checkIndex, true);
});

test("release-tier Golden TUI alias does not run TODO goldens", async () => {
    const config = JSON.parse(await fsReadFile("package.json", "utf8"));
    const normalTest = String(config.scripts?.test || "");
    const extensiveGoldenTest = String(config.scripts?.["test:golden-tui:extensive"] || "");

    assertEquals(normalTest.includes("RUNWIELD_RUN_TODO_GOLDENS"), false);
    assertEquals(extensiveGoldenTest.includes("RUNWIELD_RUN_TODO_GOLDENS"), false);
    assertStringIncludes(extensiveGoldenTest, "src/ui/tui/golden-scenarios");
});

test("release workflow runs source, Golden, and binary qualification in parallel", async () => {
    const releaseCheck = await fsReadFile(new URL("./release-check.js", import.meta.url), "utf8");
    const workflow = await fsReadFile(".github/workflows/release.yml", "utf8");

    assertStringIncludes(releaseCheck, '["run", "test:golden-tui:extensive"]');
    assertStringIncludes(workflow, "bun scripts/release-check.js --runtime bun --binary-only --build-version");
    assertStringIncludes(
        workflow,
        "bun scripts/run-tests.js --isolated src/ui/tui/testing src/ui/tui/golden-scenarios --fail-fast --timings-file",
    );
    assertMatch(workflow, /golden-shards:\n[\s\S]*?needs: metadata/);
    assertMatch(workflow, /release-check:\n[\s\S]*?needs: metadata/);
    const build = workflow.slice(workflow.indexOf("    build:"), workflow.indexOf("    assets:"));
    assertStringIncludes(build, "needs: metadata");
    const assets = workflow.slice(workflow.indexOf("    assets:"), workflow.indexOf("    windows-package-check:"));
    assertStringIncludes(assets, "needs: [metadata, build]");
    const release = workflow.slice(workflow.indexOf("    release:"), workflow.indexOf("    winget-package:"));
    for (const gate of [
        "ci",
        "golden",
        "release-check",
        "assets",
        "windows-package-check",
        "homebrew-check",
        "native-package-check",
        "unix-checks",
        "windows-checks",
        "containers-checks",
    ]) {
        assertStringIncludes(release, `- ${gate}\n`);
        assertStringIncludes(release, `needs.${gate}.result == 'success'`);
    }
});

test("Golden workflow covers direct main and release branch pushes with measured concurrency", async () => {
    const workflow = await fsReadFile(".github/workflows/golden.yml", "utf8");

    assertMatch(workflow, /push:\n\s+branches:\n\s+- main\n\s+- "release\/\*\*"/);
    assertStringIncludes(workflow, "WLD_TEST_CONCURRENCY: ${{ inputs.concurrency || '3' }}");
    assertStringIncludes(workflow, '                    - "4"');
    assertStringIncludes(workflow, "--timings-file .ci-cache/golden-timings.json");
});

test("release CLI publishes tags without owning qualification or host release mutation", async () => {
    const script = await fsReadFile(new URL("./release.js", import.meta.url), "utf8");

    assertEquals(script.includes("release create"), false);
    assertEquals(script.includes("release edit"), false);
    assertStringIncludes(script, '"gh", [');
    assertStringIncludes(script, '"release",');
    assertStringIncludes(script, '"view",');
    assertEquals(script.includes('"release:check"'), false);
    assertEquals(script.includes('"submodules:check:remote"'), false);
    assertEquals(script.includes('"branch", "--show-current"'), false);
    assertEquals(script.includes('"status", "--porcelain"'), false);
});

test("README links to wld release policy", async () => {
    const readme = await fsReadFile(new URL("../README.md", import.meta.url), "utf8");
    assertStringIncludes(readme, "[releasing](docs/releasing.md)");
});

test("release publication waits for Candidate and Stable Homebrew checks", async () => {
    const workflow = await fsReadFile(".github/workflows/release.yml", "utf8");
    const release = workflow.slice(workflow.indexOf("    release:"), workflow.indexOf("    winget-package:"));
    assertStringIncludes(release, "- homebrew-check");
    const check = workflow.slice(workflow.indexOf("    homebrew-check:"), workflow.indexOf("    release:"));
    assertEquals(check.split("        steps:")[0].includes("kind == 'stable'"), false);
    assertStringIncludes(check, "--test-only");
    assertStringIncludes(check, "brew tap 1broseidon/tap");
});

test("published recovery skips builds and verifies existing bytes before packaging", async () => {
    const workflow = await fsReadFile(".github/workflows/release.yml", "utf8");
    assertStringIncludes(workflow, "if: needs.metadata.outputs.published != 'true'");
    assertStringIncludes(workflow, 'gh release download "$RELEASE_TAG"');
    assertStringIncludes(workflow, 'release-upload "$RELEASE_TAG" published');
    assertStringIncludes(workflow, "Retain Golden failure evidence");
});

for (const jobName of ["homebrew-check", "homebrew-package"]) {
    test(`${jobName} trusts only the required dependency formulas before validation`, async () => {
        const workflow = await fsReadFile(".github/workflows/release.yml", "utf8");
        const start = workflow.indexOf(`    ${jobName}:`);
        assertEquals(start >= 0, true);
        const nextJob = workflow.slice(start + 1).search(/\n {4}[a-z][a-z-]*:/);
        const end = nextJob < 0 ? -1 : start + 1 + nextJob;
        const job = workflow.slice(start, end < 0 ? undefined : end);
        const updateIndex = job.indexOf("brew update\n");
        const tapIndex = job.indexOf("brew tap 1broseidon/tap");
        const trustIndex = job.indexOf("brew trust --formula 1broseidon/tap/cymbal\n");
        const checkIndex = job.indexOf("bun run package:homebrew:check");
        assertEquals(updateIndex >= 0, true, "Explicitly refresh Core metadata even when auto-update is disabled");
        assertEquals(tapIndex > updateIndex, true);
        assertEquals(trustIndex > tapIndex, true, "Trust Cymbal after registering its tap");
        assertEquals(checkIndex > trustIndex, true);
        assertEquals(job.includes("brew trust 1broseidon/tap"), false);
        assertEquals(job.includes("1broseidon/tap/ketch"), false);
        assertEquals(workflow.includes("HOMEBREW_NO_REQUIRE_TAP_TRUST"), false);
    });
}

test("native Homebrew jobs use a bottle-supported runner and a bounded timeout", async () => {
    const workflow = await fsReadFile(".github/workflows/release.yml", "utf8");
    for (const name of ["homebrew-check", "homebrew-package"]) {
        const job = workflow.slice(workflow.indexOf(`    ${name}:`)).split(/\n {4}[a-z][a-z-]+:/)[0];
        assertStringIncludes(job, "runs-on: macos-15");
        assertStringIncludes(job, "timeout-minutes: 30");
    }
});

test("manual recovery preserves workflow source checks and tagged product qualification", async () => {
    const workflow = await fsReadFile(".github/workflows/release.yml", "utf8");
    const ci = workflow.slice(workflow.indexOf("    ci-shards:"), workflow.indexOf("    golden-shards:"));
    assertStringIncludes(ci, 'git checkout -B main "$GITHUB_SHA"');
    assertEquals(ci.includes("ref: ${{ needs.metadata.outputs.source_sha }}"), false);
    const golden = workflow.slice(workflow.indexOf("    golden-shards:"), workflow.indexOf("    release-check:"));
    assertStringIncludes(golden, "ref: ${{ needs.metadata.outputs.source_sha }}");
    // Existing immutable RCs have the isolated runner but predate package Golden aliases.
    assertStringIncludes(golden, "bun scripts/run-tests.js --isolated src/ui/tui/testing src/ui/tui/golden-scenarios");
    assertEquals(golden.includes("bun run test:golden"), false);
});

test("release executables use pinned Bun while native package and Stable channel gates remain", async () => {
    const workflow = await fsReadFile(".github/workflows/release.yml", "utf8");
    const build = workflow.slice(workflow.indexOf("    build:"), workflow.indexOf("    assets:"));
    const binaryGate = workflow.slice(workflow.indexOf("    release-check:"), workflow.indexOf("    build:"));
    assertStringIncludes(build, "bun-version-file: .bun-version");
    assertStringIncludes(build, "bun run install:locked");
    assertStringIncludes(build, "if [ -f scripts/compile-command.ts ]; then");
    assertStringIncludes(build, 'bun run compile --output "${{ matrix.binary_name }}" --target "${{ matrix.target }}"');
    // Historical tag recovery must use the Bun command that exists in RC1.
    assertStringIncludes(build, 'bun run compile:bun "${{ matrix.binary_name }}" "${{ matrix.bun_target }}"');
    assertEquals(build.includes("scripts/compile.js"), false);
    assertStringIncludes(build, 'embedded.runtime !== "bun"');
    assertStringIncludes(binaryGate, "scripts/release-check.js --runtime bun --binary-only");
    for (const target of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"]) {
        assertStringIncludes(build, `bun_target: bun-${target}`);
    }
});
