import { assertEquals } from "../../testing/assertions.ts";
import { fileURLToPath } from "node:url";
import { runtimeSourceArgs } from "../../testing/runtime-source-args.ts";
import { captureForegroundProcess } from "../../shared/captured-process.ts";
import { test } from "node:test";
import { mkdtemp as fsMkdtemp, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { join } from "node:path";
import {
    getCliCommandDefinitions,
    getCommandDefinition,
    getSlashCommandDefinition,
    getSlashCommandDefinitions,
    getSlashCommandInvocationNames,
    hasCommandSurface,
} from "../registry.js";

test("importing the registry does not initialize the TUI", async () => {
    const home = await fsMkdtemp(join(tmpdir(), "runwield-registry-import-home-"));
    const script = join(home, "import-registry.ts");
    const registryUrl = new URL("../registry.js", import.meta.url).href;
    const tuiUrl = new URL("../../ui/tui/tui.ts", import.meta.url).href;
    await fsWriteFile(
        script,
        [
            `import "${registryUrl}";`,
            `import { getTUI } from "${tuiUrl}";`,
            "try {",
            "  getTUI();",
            "  console.log('initialized');",
            "} catch (error) {",
            "  if (!(error instanceof Error) || !error.message.includes('TUI not initialized')) throw error;",
            "}",
        ].join("\n"),
    );
    const result = await captureForegroundProcess(process.execPath, {
        args: runtimeSourceArgs(["run", "-A", "--config", "deno.json", script]),
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        env: { HOME: home, WLD_TEST_SANDBOX_HOME: home, MNEMOTECA_DB_PATH: join(home, "mnemoteca.sqlite") },
    });
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assertEquals(new TextDecoder().decode(result.stdout), "");
});

test("plan-review help explains Session restart and saved content", () => {
    const command = getSlashCommandDefinition("plan-review");
    assertEquals(
        command?.notes?.some((note) => note.includes("current Session") && note.includes("restart")),
        true,
    );
    assertEquals(
        command?.notes?.some((note) => note.includes("current saved Plan") && note.includes("lost review page")),
        true,
    );
});

test("getCommandDefinition resolves alias", () => {
    const command = getCommandDefinition("agents");
    assertEquals(command?.name, "agent");
});

test("getCliCommandDefinitions excludes slash-only commands", () => {
    const commands = getCliCommandDefinitions();
    assertEquals(
        commands.some((command) => command.name === "export"),
        false,
    );
    assertEquals(
        commands.some((command) => command.name === "settings"),
        false,
    );
    assertEquals(
        commands.some((command) => command.name === "router"),
        true,
    );
    assertEquals(
        commands.some((command) => command.name === "acp"),
        true,
    );
    assertEquals(
        commands.some((command) => command.name === "workspace"),
        true,
    );
    assertEquals(
        commands.some((command) => command.name === "login"),
        true,
    );
});

test("getSlashCommandDefinitions excludes cli-only commands", () => {
    const commands = getSlashCommandDefinitions();
    assertEquals(
        commands.some((command) => command.name === "plans"),
        false,
    );
    assertEquals(
        commands.some((command) => command.name === "acp"),
        false,
    );
    assertEquals(
        commands.some((command) => command.name === "theme"),
        true,
    );
    assertEquals(
        commands.some((command) => command.name === "settings"),
        true,
    );
    assertEquals(
        commands.some((command) => command.name === "login"),
        true,
    );
});

test("registry surfaces capture theme, model, and login CLI support", () => {
    const theme = getCommandDefinition("theme");
    const model = getCommandDefinition("model");
    const login = getCommandDefinition("login");
    assertEquals(theme ? hasCommandSurface(theme, "cli") : false, true);
    assertEquals(theme ? hasCommandSurface(theme, "slash") : false, true);
    assertEquals(model ? hasCommandSurface(model, "cli") : false, true);
    assertEquals(model ? hasCommandSurface(model, "slash") : false, true);
    assertEquals(login ? hasCommandSurface(login, "cli") : false, true);
    assertEquals(login ? hasCommandSurface(login, "slash") : false, true);
});

test("getSlashCommandDefinition resolves slash aliases", () => {
    const command = getSlashCommandDefinition("models");
    assertEquals(command?.name, "model");
});

test("update command is CLI-only and upgrade resolves to update", () => {
    const command = getCommandDefinition("update");
    assertEquals(command?.name, "update");
    assertEquals(getCommandDefinition("upgrade")?.name, "update");
    assertEquals(command ? hasCommandSurface(command, "cli") : false, true);
    assertEquals(command ? hasCommandSurface(command, "slash") : true, false);
    assertEquals(getSlashCommandDefinition("update"), undefined);
    assertEquals(getSlashCommandDefinition("upgrade"), undefined);
    assertEquals(
        getSlashCommandDefinitions().some((definition) => definition.name === "update"),
        false,
    );
});

test("onboard is a CLI command and a TUI-only slash command", () => {
    const command = getCommandDefinition("onboard");
    assertEquals(command?.name, "onboard");
    assertEquals(command ? hasCommandSurface(command, "cli") : false, true);
    assertEquals(getSlashCommandDefinition("onboard", "tui")?.name, "onboard");
    assertEquals(getSlashCommandDefinition("onboard", "acp"), undefined);
    assertEquals(getSlashCommandDefinition("onboard", "workspace"), undefined);
});

test("workspace command is CLI-only", () => {
    const command = getCommandDefinition("workspace");
    assertEquals(command?.name, "workspace");
    assertEquals(command ? hasCommandSurface(command, "cli") : false, true);
    assertEquals(command ? hasCommandSurface(command, "slash") : true, false);
    assertEquals(getSlashCommandDefinition("workspace"), undefined);
});

test("context command is a slash-only built-in", () => {
    const command = getCommandDefinition("context");
    assertEquals(command?.name, "context");
    assertEquals(command ? hasCommandSurface(command, "cli") : true, false);
    assertEquals(command ? hasCommandSurface(command, "slash") : false, true);
    assertEquals(
        getCliCommandDefinitions().some((definition) => definition.name === "context"),
        false,
    );
    assertEquals(getSlashCommandDefinition("context")?.name, "context");
    assertEquals(
        getSlashCommandDefinitions().some((definition) => definition.name === "context"),
        true,
    );
});

test("ACP slash surface exposes TUI built-ins except approved exclusions", () => {
    const names = getSlashCommandDefinitions("acp")
        .map((command) => command.name)
        .sort();
    assertEquals(names.includes("agent"), true);
    assertEquals(names.includes("model"), true);
    assertEquals(names.includes("load-plan"), true);
    assertEquals(names.includes("settings"), true);
    assertEquals(names.includes("reload"), true);
    for (const excluded of ["copy", "theme", "quit", "exit", "new", "resume", "login"]) {
        assertEquals(names.includes(excluded), false, excluded);
        assertEquals(getSlashCommandDefinition(excluded, "acp"), undefined, excluded);
    }
    assertEquals(getSlashCommandDefinition("agents", "acp")?.name, "agent");
    assertEquals(getSlashCommandDefinition("models", "acp")?.name, "model");
});

test("Workspace slash surface comes from the registry and keeps current coverage", () => {
    assertEquals(
        getSlashCommandDefinitions("workspace").map((command) => command.name),
        ["agent", "model", "plan-review", "resume", "new", "session", "context", "plans", "help", "settings"],
    );
    for (const excluded of ["theme", "quit", "exit"]) {
        assertEquals(getSlashCommandDefinition(excluded, "workspace"), undefined, excluded);
    }
});

test("disabled built-ins and aliases are still reserved names on other slash surfaces", () => {
    assertEquals(getCommandDefinition("login")?.name, "login");
    assertEquals(getSlashCommandDefinition("login", "acp"), undefined);
    assertEquals(getSlashCommandDefinition("resume", "acp"), undefined);
    assertEquals(getSlashCommandInvocationNames("acp").includes("agents"), true);
    assertEquals(getSlashCommandInvocationNames("acp").includes("login"), false);
});
