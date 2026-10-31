import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import schema from "../../../config.schema.json" with { type: "json" };
import { withProcessGlobalTestLock } from "../../testing/process-global-lock.ts";
import {
    __resetSettingsForTests,
    getCustomSetting,
    getSettingsManager,
    preserveRunWieldCustomSettingsForWrite,
    setCustomSetting,
} from "../settings.js";
import { git } from "../git-test-fixture.ts";
import { resolveCodexRoleSettings } from "./codex-role-settings.ts";
import { ATTACHED_HOST_ROLES, type AttachedJsonObject, type AttachedJsonValue } from "./operations.ts";
import {
    activateInput,
    EVIDENCE,
    pendingTriage,
    spawnAttachedCli,
    runOperation,
    withProject,
} from "./attached-test-fixture.ts";

async function withSettings(body: (root: string, home: string) => Promise<void>) {
    await withProcessGlobalTestLock(async () => {
        const home = await mkdtemp(join(tmpdir(), "codex-role-home-"));
        const previousHome = process.env.HOME;
        process.env.HOME = home;
        __resetSettingsForTests();
        try {
            await withProject((root) => body(root, home));
        } finally {
            if (previousHome === undefined) delete process.env.HOME;
            else process.env.HOME = previousHome;
            __resetSettingsForTests();
            await rm(home, { recursive: true, force: true });
        }
    });
}

async function writeSettings(root: string, roles: AttachedJsonObject) {
    await mkdir(join(root, ".wld"), { recursive: true });
    await writeFile(
        join(root, ".wld/settings.json"),
        `// Personal or project JSONC\n${JSON.stringify({ connect: { codex: { roles } } })}\n`,
    );
}

test("settings schema exposes exactly the supported Codex roles and host-native strings", () => {
    assert.deepEqual(ATTACHED_HOST_ROLES, [
        "router",
        "planner",
        "engineer",
        "frontend-engineer",
        "reviewer",
        "reviewer-feedback-engineer",
        "recorder",
    ]);
    const roles = schema.properties.connect.properties.codex.properties.roles;
    assert.deepEqual(Object.keys(roles.properties), ATTACHED_HOST_ROLES);
    assert.equal(roles.additionalProperties, false);
    const preferences = schema.$defs.codexRolePreferences;
    assert.equal(preferences.additionalProperties, false);
    for (const field of [preferences.properties.model, preferences.properties.thinkingLevel]) {
        assert.equal(field.type, "string");
        assert.equal(field.default, "inherit");
        assert.equal("enum" in field, false);
        assert(new RegExp(field.pattern).test("future-native-value"));
        assert.equal(new RegExp(field.pattern).test(" "), false);
    }
});

test("all seven Codex roles inherit without consulting Core presets", async () => {
    await withSettings(async (root) => {
        await setCustomSetting(
            "agents",
            { planner: { model: "provider/core-model", thinkingLevel: "high" } },
            "project",
            root,
        );
        await setCustomSetting("activeModelPreset", "codex", "project", root);
        await setCustomSetting("modelPresets", { codex: { planner: { model: "provider/preset" } } }, "project", root);
        for (const role of ATTACHED_HOST_ROLES) {
            assert.deepEqual(resolveCodexRoleSettings(root, role), {
                host: "codex",
                role,
                status: "ready",
                model: "inherit",
                thinkingLevel: "inherit",
            });
        }
    });
});

test("personal models and efforts resolve independently for every supported role", async () => {
    await withSettings(async (root, home) => {
        await writeSettings(
            home,
            Object.fromEntries(
                ATTACHED_HOST_ROLES.map((role) => [role, { model: `native-${role}`, thinkingLevel: "ultra" }]),
            ),
        );
        await writeSettings(root, {
            planner: { thinkingLevel: "max" },
            engineer: { model: "project-model" },
            router: { model: "inherit" },
            recorder: { thinkingLevel: "inherit" },
        });
        for (const role of ATTACHED_HOST_ROLES) {
            const result = resolveCodexRoleSettings(root, role);
            assert.equal(result.status, "ready");
            assert(result.status === "ready");
            assert.equal(
                result.model,
                role === "router" ? "inherit" : role === "engineer" ? "project-model" : `native-${role}`,
            );
            assert.equal(result.thinkingLevel, role === "planner" ? "max" : role === "recorder" ? "inherit" : "ultra");
        }
    });
});

test("model-only and effort-only preferences leave the other native spawn field inherited", async () => {
    await withSettings(async (root) => {
        await writeSettings(root, {
            planner: { model: "future-native-model" },
            engineer: { thinkingLevel: "future-effort" },
        });
        assert.deepEqual(resolveCodexRoleSettings(root, "planner"), {
            host: "codex",
            role: "planner",
            status: "ready",
            model: "future-native-model",
            thinkingLevel: "inherit",
        });
        assert.deepEqual(resolveCodexRoleSettings(root, "engineer"), {
            host: "codex",
            role: "engineer",
            status: "ready",
            model: "inherit",
            thinkingLevel: "future-effort",
        });
    });
});

const malformed: [string, AttachedJsonValue][] = [
    ["connect", false],
    ["connect.codex", { codex: [] }],
    ["connect.codex.role", { codex: { role: {} } }],
    ["connect.codex.roles", { codex: { roles: "planner" } }],
    ["connect.codex.roles.planer", { codex: { roles: { planer: { model: "native" } } } }],
    ["connect.codex.roles.planner", { codex: { roles: { planner: null } } }],
    ["connect.codex.roles.planner.thinking", { codex: { roles: { planner: { thinking: "high" } } } }],
    ...["", "  ", " native ", 5, null, [], {}].map((model): [string, AttachedJsonValue] => [
        "connect.codex.roles.planner.model",
        { codex: { roles: { planner: { model } } } },
    ]),
    ["connect.codex.roles.planner.thinkingLevel", { codex: { roles: { planner: { thinkingLevel: false } } } }],
];
for (const [index, [field, value]] of malformed.entries()) {
    test(`malformed Codex preference ${index + 1} names the settings file and field without falling back`, async () => {
        await withSettings(async (root, home) => {
            await writeSettings(home, { planner: { model: "personal-model" } });
            await setCustomSetting("connect", value, "project", root);
            const result = resolveCodexRoleSettings(root, "planner");
            assert.equal(result.status, "invalid");
            assert(result.status === "invalid");
            assert(result.diagnostics[0].includes(join(root, ".wld/settings.json")));
            assert(result.diagnostics[0].includes(field));
            assert.equal("model" in result, false);
        });
    });
}

for (const content of ["{ malformed", "", "null", "[]", "42"]) {
    test(`malformed settings document ${JSON.stringify(content)} prevents silent native inheritance`, async () => {
        await withSettings(async (root) => {
            await mkdir(join(root, ".wld"), { recursive: true });
            await writeFile(join(root, ".wld/settings.json"), content);
            const result = resolveCodexRoleSettings(root, "router");
            assert(result.status === "invalid");
            assert(result.diagnostics[0].includes(join(root, ".wld/settings.json")));
        });
    });
}

test("unreadable settings are diagnosed instead of treated as absent", async () => {
    await withSettings(async (root) => {
        await mkdir(join(root, ".wld/settings.json"), { recursive: true });
        const result = resolveCodexRoleSettings(root, "router");
        assert(result.status === "invalid");
        assert(result.diagnostics[0].includes(join(root, ".wld/settings.json")));
    });
});

test("Codex settings survive custom and SettingsManager writes with unrelated keys preserved", async () => {
    await withSettings(async (root) => {
        const connect = {
            codex: { roles: { reviewer: { model: "native-reviewer", thinkingLevel: "high" } } },
            otherHost: { value: "keep" },
        };
        await setCustomSetting("modelPresets", { base: { reviewer: { model: "core/model" } } }, "project", root);
        await setCustomSetting("connect", connect, "project", root);
        await setCustomSetting("verification_command", "true", "project", root);
        const manager = getSettingsManager(root);
        manager.setTheme("light");
        await manager.flush();
        assert.deepEqual(getCustomSetting("connect", "project", root), connect);
        assert.deepEqual(getCustomSetting("modelPresets", "project", root), {
            base: { reviewer: { model: "core/model" } },
        });
        assert.equal(getCustomSetting("verification_command", "project", root), "true");
        assert.deepEqual(
            JSON.parse(preserveRunWieldCustomSettingsForWrite(JSON.stringify({ connect }), '{"theme":"dark"}')),
            { theme: "dark", connect },
        );
    });
});

test("linked execution worktrees read project preferences from the primary checkout", async () => {
    await withSettings(async (root) => {
        const linked = `${root}-execution`;
        await git(root, ["worktree", "add", "-b", "role-settings", linked, "HEAD"]);
        try {
            await writeSettings(root, { engineer: { model: "primary-model" } });
            await writeSettings(linked, { engineer: { model: "stale-worktree-model" } });
            assert.deepEqual(resolveCodexRoleSettings(linked, "engineer"), {
                host: "codex",
                role: "engineer",
                status: "ready",
                model: "primary-model",
                thinkingLevel: "inherit",
            });
        } finally {
            await git(root, ["worktree", "remove", "--force", linked]);
        }
    });
});

test("fresh processes re-read saved preferences, explicit reset, and removal for the same action", async () => {
    await withSettings(async (root, home) => {
        const evidence = { ...EVIDENCE, host: "codex", hostVersion: "0.164.0-alpha.11.1" };
        const triage = pendingTriage(await runOperation("activate", root, { ...activateInput(), evidence }));
        await writeSettings(home, { router: { model: "personal-model", thinkingLevel: "high" } });
        for (const [roles, model, thinkingLevel] of [
            [{ router: { thinkingLevel: "max" } }, "personal-model", "max"],
            [{ router: { model: "inherit", thinkingLevel: "inherit" } }, "inherit", "inherit"],
            [{}, "personal-model", "high"],
        ] as const) {
            await writeSettings(root, roles);
            const restored = await spawnAttachedCli("get_instructions", root, { ...triage, evidence });
            assert.equal(restored.code, 0, restored.stderr);
            assert(restored.result.ok && "instructions" in restored.result);
            assert.deepEqual(restored.result.instructions.dispatch, {
                host: "codex",
                role: "router",
                status: "ready",
                model,
                thinkingLevel,
            });
            assert.equal(restored.result.actionId, triage.actionId);
        }
    });
});
