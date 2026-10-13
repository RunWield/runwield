import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { match as assertMatch } from "node:assert/strict";

// On hosts without Linux FUSE, these checks guard the independent monitor wiring.
// The opt-in real SSHFS test in sftp-mount.test.ts verifies mount loss end to end.
test("mounted storage has an independent bounded lookup and mount identity check", async () => {
    const source = await fsReadFile(new URL("./sftp-mount.ts", import.meta.url), "utf8");
    assertMatch(source, /setInterval\(\(\) => \{\s*void checkStorage\(\);\s*\}, 5_000\)/);
    assertMatch(source, /fsStat\(join\(path, `\.wld-health-\$\{crypto\.randomUUID\(\)\}`\)\)/);
    assertMatch(source, /before\?\.id !== mountId[\s\S]*after\?\.id !== mountId/);
    assertMatch(source, /Promise\.race\(\[\s*lookup\(\)[\s\S]*setTimeout\(\(\) => resolve\("timed out"\), 30_000\)/);
    assertMatch(source, /lost: Promise\.race\(\[storageFailure, \.\.\.active\.map/);
});

test("a timed-out storage request keeps cleanup uncertain", async () => {
    const source = await fsReadFile(new URL("./sftp-mount.ts", import.meta.url), "utf8");
    assertMatch(source, /if \(probePending\) uncertain = true/);
    assertMatch(source, /if \(result === "timed out"\) uncertain = true/);
    assertMatch(source, /if \(uncertain\) \{\s*throw new Error\([\s\S]*?SSHFS cleanup uncertain;/);
});
