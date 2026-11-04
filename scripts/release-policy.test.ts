import { test } from "node:test";
import { readFile as fsReadFile } from "node:fs/promises";
import { match as assertMatch } from "node:assert/strict";
import { load } from "js-yaml";
import { assertEquals, assertStringIncludes } from "../src/testing/assertions.ts";

interface ReleaseStep {
    name?: string;
    id?: string;
    uses?: string;
    if?: string;
    run?: string;
    with?: Record<string, string | boolean | number>;
    env?: Record<string, string>;
}
interface ReleaseJob {
    needs?: string | string[];
    if?: string;
    "runs-on"?: string;
    "timeout-minutes"?: number;
    steps: ReleaseStep[];
}
interface ReleaseWorkflow {
    on: {
        push?: { branches?: string[]; tags?: string[] };
        workflow_dispatch?: { inputs: Record<string, { required?: boolean; default?: string | boolean }> };
    };
    jobs: Record<string, ReleaseJob>;
}
async function workflow(name = "release"): Promise<ReleaseWorkflow> {
    return load(await fsReadFile(`.github/workflows/${name}.yml`, "utf8")) as ReleaseWorkflow;
}
function script(job: ReleaseJob): string {
    return job.steps.map((step) => step.run || "").join("\n");
}
function checkout(job: ReleaseJob): ReleaseStep {
    const step = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    if (!step) throw new Error("Release job has no checkout");
    return step;
}

test("release prompt starts with the three release choices before policy discovery", async () => {
    const prompt = await fsReadFile(new URL("../src/prompt-templates/release.md", import.meta.url), "utf8");
    const choiceIndex = prompt.indexOf("What kind of release operation should I run?");
    const discoveryIndex = prompt.indexOf("Discover the repository's release policy");

    assertEquals(choiceIndex >= 0, true);
    assertEquals(discoveryIndex > choiceIndex, true);
    assertStringIncludes(prompt, "Create Candidate");
    assertStringIncludes(prompt, "Promote Candidate");
    assertStringIncludes(prompt, "Create Stable Directly");
    assertStringIncludes(prompt, "Follow repository-specific policy first");
    assertMatch(prompt, /If no repository-specific release-note scope is\s+documented/);
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

// Workflow YAML is a deployed interface to GitHub Actions. Check the parsed
// graph and action inputs, rather than finding tokens anywhere in source text.
test("publication requires all qualification gates and preserves release channel and immutable bytes", async () => {
    const jobs = (await workflow()).jobs;
    const release = jobs.release;
    for (const gate of [
        "ci",
        "golden",
        "release-check",
        "assets",
        "homebrew-check",
        "native-package-check",
        "unix-checks",
        "containers-checks",
    ]) {
        assertEquals(release.needs?.includes(gate), true, `Publication must depend on ${gate}`);
        assertStringIncludes(release.if || "", `needs.${gate}.result == 'success'`);
    }
    const publish = release.steps.find((step) => step.uses?.startsWith("softprops/action-gh-release@"));
    assertEquals(publish?.if, "needs.metadata.outputs.published != 'true'");
    assertEquals(publish?.with?.tag_name, "${{ needs.metadata.outputs.tag }}");
    assertEquals(publish?.with?.prerelease, "${{ needs.metadata.outputs.prerelease }}");
    assertEquals(publish?.with?.make_latest, "${{ needs.metadata.outputs.make_latest }}");
    assertEquals(publish?.with?.overwrite_files, false);
    assertEquals(publish?.with?.fail_on_unmatched_files, true);
    assertEquals(publish?.with?.files, "release-upload/*");
    assertEquals(jobs.assets.needs, ["metadata", "build", "docs-artifact"]);
    assertEquals(jobs.build.if, "needs.metadata.outputs.published != 'true'");
    const recover = jobs.assets.steps.find((step) => step.if === "needs.metadata.outputs.published == 'true'");
    assertStringIncludes(recover?.run || "", 'gh release download "$RELEASE_TAG"');
    assertStringIncludes(recover?.run || "", 'release-upload "$RELEASE_TAG" published published-release.json');
});

test("recovery qualifies immutable tagged product with current workflow tooling", async () => {
    const config = await workflow();
    assertEquals(config.on.push?.tags, ["v*"]);
    assertEquals(config.on.workflow_dispatch?.inputs.tag.required, false);
    const jobs = config.jobs;
    assertEquals(checkout(jobs.metadata).with?.ref, "${{ github.sha }}");
    assertStringIncludes(
        script(jobs.metadata),
        'git fetch --no-recurse-submodules --no-tags origin "refs/tags/$RELEASE_TAG"',
    );
    for (const name of ["release-check", "build", "release", "golden-shards"]) {
        assertEquals(checkout(jobs[name]).with?.ref, "${{ needs.metadata.outputs.source_sha }}");
    }
    assertEquals(checkout(jobs["ci-shards"]).with?.ref, "${{ github.sha }}");
    assertStringIncludes(script(jobs["ci-shards"]), 'git checkout -B main "$GITHUB_SHA"');
    assertStringIncludes(
        script(jobs["golden-shards"]),
        "bun scripts/run-tests.js --isolated src/ui/tui/testing src/ui/tui/golden-scenarios",
    );
    assertStringIncludes(script(jobs["release-check"]), "--runtime bun --binary-only");
    assertStringIncludes(
        script(jobs.build),
        'bun run compile:bun "${{ matrix.binary_name }}" "${{ matrix.bun_target }}"',
    );
    const compile = jobs.build.steps.find((step) => step.run?.includes("bun run compile --output"));
    assertEquals(compile?.env?.WLD_BUILD_VERSION, "${{ needs.metadata.outputs.build_version }}");
    const schema = jobs.assets.steps.find((step) => step.with?.path === "release-source");
    assertEquals(schema?.with?.ref, "${{ needs.metadata.outputs.source_sha }}");
});

test("release tooling installs local dependencies before qualification", async () => {
    const jobs = (await workflow()).jobs;
    for (const name of ["metadata", "docs-artifact", "assets", "homebrew-check", "homebrew-package", "build"]) {
        const job = jobs[name];
        assertEquals(checkout(job).with?.submodules, "recursive", name);
        const install = job.steps.findIndex((step) => step.run === "bun run install:locked");
        assertEquals(install > job.steps.indexOf(checkout(job)), true, name);
        assertEquals(
            job.steps.some(
                (step) =>
                    step.with?.["bun-version-file"] ===
                    (name === "docs-artifact" ? "tooling/.bun-version" : ".bun-version"),
            ),
            true,
        );
    }
});

test("Homebrew validates both channels but publishes only qualified Stable dependency snapshots", async () => {
    const jobs = (await workflow()).jobs;
    const check = jobs["homebrew-check"];
    const publish = jobs["homebrew-package"];
    assertEquals(check.if?.includes("kind == 'stable'"), false);
    assertStringIncludes(script(check), "--test-only");
    assertStringIncludes(publish.if || "", "needs.metadata.outputs.kind == 'stable'");
    assertStringIncludes(publish.if || "", "needs.release.result == 'success'");
    for (const job of [check, publish]) {
        assertEquals(job["runs-on"], "macos-15");
        assertEquals(job["timeout-minutes"], 30);
        const commands = script(job);
        assertEquals(commands.includes("--mnemoteca-tag"), false);
        assertEquals(commands.includes("HOMEBREW_NO_REQUIRE_TAP_TRUST"), false);
        const update = commands.indexOf("brew update\n");
        const tap = commands.indexOf("brew tap 1broseidon/tap");
        const trust = commands.indexOf("brew trust --formula 1broseidon/tap/cymbal\n");
        const qualify = commands.indexOf("bun run package:homebrew:check");
        assertEquals(update >= 0 && tap > update && trust > tap && qualify > trust, true);
        assertEquals(commands.includes("brew trust 1broseidon/tap"), false);
        const base = job.steps.findIndex((step) => step.with?.repository === "RunWield/homebrew-tap");
        const render = job.steps.findIndex((step) => step.run?.includes("bun run package:homebrew "));
        assertEquals(base >= 0 && render > base, true);
    }
    const commands = script(publish);
    const validate = commands.indexOf("bun run package:homebrew:check");
    const archive = commands.indexOf("tar -czf");
    const publication = commands.indexOf("bun scripts/publish-homebrew.ts");
    assertEquals(archive > validate && publication > archive, true);
    const final = publish.steps.find((step) => step.run?.includes("bun scripts/publish-homebrew.ts"));
    assertEquals(final?.env?.TAP_BASE, "${{ steps.tap-base.outputs.sha }}");
    assertStringIncludes(final?.run || "", 'homebrew-tap-publish homebrew-tap "$TAP_BASE" "$RELEASE_TAG"');
    assertEquals(
        publish.steps.find((step) => step.with?.repository === "RunWield/homebrew-tap")?.with?.token,
        "${{ secrets.HOMEBREW_TAP_TOKEN }}",
    );
    assertStringIncludes(script(check), "gh api repos/RunWield/homebrew-tap --jq '.permissions.push' | grep -Fx true");
});

test("Golden qualification runs for direct main and release-branch pushes", async () => {
    assertEquals((await workflow("golden")).on.push?.branches, ["main", "release/**"]);
});

test("manual Homebrew preparation requires explicit package selection and archives no checkout metadata", async () => {
    const config = await workflow("homebrew-prepare");
    const commands = Object.values(config.jobs).map(script).join("\n");
    assertEquals(
        Object.values(config.on.workflow_dispatch?.inputs || {}).some((input) => input.default === "v0.3.3"),
        false,
    );
    assertStringIncludes(commands, 'test -n "$WLD_TAG$MNEMOTECA_TAG"');
    assertStringIncludes(commands, "-C homebrew-tap Formula README.md runwield-homebrew-package.json");
    assertEquals(commands.includes("-C homebrew-tap ."), false);
    const steps = Object.values(config.jobs).flatMap((job) => job.steps);
    const tap = steps.find((step) => step.with?.repository === "RunWield/homebrew-tap");
    assertEquals(tap?.with?.["persist-credentials"], false);
});
