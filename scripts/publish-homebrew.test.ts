import { test } from "node:test";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineGitFixture, git } from "../src/shared/git-test-fixture.ts";
import { assertEquals, assertRejects, assertStringIncludes } from "../src/testing/assertions.ts";
import { publishHomebrew } from "./publish-homebrew.ts";

const MANIFEST = "runwield-homebrew-package.json";
const formula = (tag: string) =>
    ["darwin-arm64", "darwin-x64"]
        .map(
            (arch) =>
                `url "https://github.com/RunWield/runwield/releases/download/${tag}/wld-${tag}-${arch}.tar.gz"\nsha256 "${"a".repeat(64)}"\n`,
        )
        .join("");
const manifest = (mnemotecaTag = "v0.3.4", wldTag = "v1.2.3") => ({
    wldTag,
    mnemotecaTag,
    testOnly: false,
    generatedAt: "2026-10-30T00:00:00Z",
    formulas: ["Formula/wld.rb", "Formula/mnemoteca.rb"],
    testedDependencies: { ketch: { testedVersion: "v0.8.3" } },
    extra: { preserved: true },
});
const fixture = defineGitFixture(async (root) => {
    await mkdir(join(root, "Formula"));
    await writeFile(join(root, "Formula/wld.rb"), formula("v1.2.3"));
    await writeFile(join(root, "Formula/mnemoteca.rb"), "independent Mnemoteca v0.3.4\n");
    await writeFile(join(root, "README.md"), "independent readme\n");
    await writeFile(join(root, MANIFEST), JSON.stringify(manifest()));
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "tap base"]);
});

async function setup() {
    const root = await fixture.checkout();
    const remote = join(root, "remote.git");
    await git(root, ["clone", "--bare", root, remote]);
    const tap = join(root, "publication");
    await git(root, ["clone", remote, tap]);
    const base = await git(tap, ["rev-parse", "HEAD"]);
    const checked = join(root, "checked");
    await mkdir(checked);
    for (const path of ["Formula", "README.md", MANIFEST])
        await cp(join(tap, path), join(checked, path), { recursive: true });
    await writeFile(join(checked, "Formula/wld.rb"), formula("v1.2.4"));
    await writeFile(join(checked, MANIFEST), JSON.stringify(manifest("v0.3.4", "v1.2.4")));
    return { root, remote, tap, checked, base, tag: "v1.2.4" };
}

async function advance(root: string, remote: string) {
    const writer = join(root, "writer");
    await git(root, ["clone", remote, writer]);
    await writeFile(join(writer, "Formula/mnemoteca.rb"), "independent Mnemoteca v0.3.5\n");
    await writeFile(join(writer, MANIFEST), JSON.stringify(manifest("v0.3.5")));
    await git(writer, ["add", "."]);
    await git(writer, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Mnemoteca v0.3.5",
    ]);
    await git(writer, ["push", "origin", "main"]);
}

test("Homebrew publication changes only verified wld and its manifest fields", async () => {
    const f = await setup();
    try {
        await publishHomebrew(f);
        assertEquals((await git(f.remote, ["diff", "--name-only", f.base, "main"])).split("\n"), [
            "Formula/wld.rb",
            MANIFEST,
        ]);
        assertEquals(JSON.parse(await git(f.remote, ["show", `main:${MANIFEST}`])), manifest("v0.3.4", "v1.2.4"));
        assertEquals(await git(f.remote, ["show", "main:Formula/wld.rb"]), formula(f.tag).trim());
        assertEquals(await git(f.remote, ["show", "main:Formula/mnemoteca.rb"]), "independent Mnemoteca v0.3.4");
    } finally {
        await rm(f.root, { recursive: true });
    }
});

for (const timing of ["before checkout", "after checkout"]) {
    test(`Homebrew publication rejects a dependency advance ${timing} and preserves it on fresh retry`, async () => {
        const f = await setup();
        try {
            await advance(f.root, f.remote);
            if (timing === "before checkout") {
                const late = join(f.root, "late-checkout");
                await git(f.root, ["clone", f.remote, late]);
                // A late checkout at the newer default HEAD must not count as qualified.
                await assertRejects(() => publishHomebrew({ ...f, tap: late }), Error, "qualified tap revision");
                await git(late, ["checkout", "--detach", f.base]);
                f.tap = late;
            }
            await assertRejects(() => publishHomebrew(f), Error, "rejected");
            assertStringIncludes(await git(f.remote, ["show", "main:Formula/wld.rb"]), "/v1.2.3/");
            assertEquals(await git(f.remote, ["show", "main:Formula/mnemoteca.rb"]), "independent Mnemoteca v0.3.5");
            const fresh = join(f.root, "fresh");
            await git(f.root, ["clone", f.remote, fresh]);
            const base = await git(fresh, ["rev-parse", "HEAD"]);
            await cp(join(fresh, "Formula/mnemoteca.rb"), join(f.checked, "Formula/mnemoteca.rb"));
            await writeFile(join(f.checked, MANIFEST), JSON.stringify(manifest("v0.3.5", f.tag)));
            await publishHomebrew({ ...f, tap: fresh, base });
            assertEquals(await git(f.remote, ["show", "main:Formula/mnemoteca.rb"]), "independent Mnemoteca v0.3.5");
            assertEquals(JSON.parse(await git(f.remote, ["show", `main:${MANIFEST}`])), manifest("v0.3.5", f.tag));
        } finally {
            await rm(f.root, { recursive: true });
        }
    });
}

for (const path of ["Formula/mnemoteca.rb", "README.md", MANIFEST, "Formula/wld.rb"]) {
    test(`Homebrew publication refuses altered checked ${path}`, async () => {
        const f = await setup();
        try {
            await writeFile(
                join(f.checked, path),
                path === MANIFEST ? JSON.stringify({ ...manifest("v0.3.3", f.tag) }) : "changed\n",
            );
            await assertRejects(() => publishHomebrew(f));
            assertEquals(await git(f.remote, ["rev-parse", "main"]), f.base);
            assertEquals(await git(f.tap, ["status", "--porcelain"]), "");
        } finally {
            await rm(f.root, { recursive: true });
        }
    });
}

for (const change of ["shared checkout", "dirty checkout", "test-only", "wrong asset filename"]) {
    test(`Homebrew publication rejects ${change} without publishing`, async () => {
        const f = await setup();
        try {
            let message = "";
            if (change === "shared checkout") {
                f.checked = f.tap;
                message = "separate disposable copy";
            } else if (change === "dirty checkout") {
                await writeFile(join(f.tap, "README.md"), "uncommitted owner changes\n");
                message = "must be clean";
            } else if (change === "test-only") {
                await writeFile(
                    join(f.checked, MANIFEST),
                    JSON.stringify({ ...manifest("v0.3.4", f.tag), testOnly: true }),
                );
                message = "not a publishable package";
            } else {
                await writeFile(join(f.checked, "Formula/wld.rb"), formula(f.tag).replace("darwin-x64", "linux-x64"));
                message = "requested Stable release assets";
            }
            await assertRejects(() => publishHomebrew(f), Error, message);
            assertEquals(await git(f.remote, ["rev-parse", "main"]), f.base);
            assertEquals(await git(f.tap, ["show", "HEAD:Formula/wld.rb"]), formula("v1.2.3").trim());
        } finally {
            await rm(f.root, { recursive: true });
        }
    });
}
