import { equal, ok } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getCwd, getHomeDir } from "../../constants.ts";
import { extractYaml } from "../../shared/front-matter.ts";
import { listSkills } from "../../shared/session/skill-catalog.ts";
import { resolveNamedInvocation } from "../../shared/session/named-invocation.ts";

/** Exercise bundled selection and expansion without a model or public Skills checkout. */
export async function checkPackagedSkills(): Promise<void> {
    const cwd = getCwd();
    const skills = (await listSkills({ cwd })).filter((skill) => skill.name === "write-tests");
    equal(skills.length, 1, "Package must include exactly one write-tests Skill");
    equal(skills[0].source, "bundled");
    equal(skills[0].path, join(getHomeDir(), ".wld", "bundled-skills", "write-tests", "SKILL.md"));
    const resolved = await resolveNamedInvocation({ cwd, text: "/skill:write-tests check the recovery contract" });
    equal(resolved.kind, "skill");
    if (resolved.kind !== "skill") throw new Error("Packaged write-tests invocation did not resolve");
    equal(resolved.payload.source.layer, "bundled");
    equal(resolved.additionalInstructions, "check the recovery contract");
    ok(resolved.expandedRequest.includes("check the recovery contract"));
    ok(resolved.expandedRequest.includes(`location="${skills[0].path}"`));
    ok(resolved.expandedRequest.includes("## Decide Whether a Test Is Warranted"));
    ok(resolved.expandedRequest.includes("### Fake the environment, never your own machinery"));
    const raw = await readFile(skills[0].path, "utf8");
    ok(resolved.expandedRequest.includes(extractYaml(raw).body.trim()));
}
