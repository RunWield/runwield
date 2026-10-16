/**
 * @module cli
 * RunWield — Plan-by-Default Coding Harness
 *
 * Usage:
 *   wld "<user request>"
 *   wld router "<user request>"
 *   wld load-plan <plan-name-or-path>
 *   wld plans
 *   wld sleep
 *   wld help
 *
 * Source-run fallback for contributors:
 *   bun src/cli.ts "<user request>"
 */

import { argv, env, execArgv, execPath, exit, ppid } from "node:process";
import { parseArgs } from "./shared/cli-args.ts";
import { isStandaloneExecutable } from "./shared/runtime-identity.ts";
import { superviseRuntime } from "./shared/runtime-supervisor.ts";

// Keep the supervisor outside every command and startup import. A native Bun
// abort cannot reach JavaScript catch/finally blocks in the working runtime.
// Match the actual parent so nested wld invocations get their own supervisor.
if (env.WLD_RUNTIME_SUPERVISOR_PID !== String(ppid)) {
    // Bun consumes one leading separator on source startup. Preserve a literal
    // separator when the supervisor starts the working CLI.
    const sourceArgs = [...execArgv, argv[1], ...(argv[2] === "--" ? ["--"] : []), ...argv.slice(2)];
    exit(await superviseRuntime(execPath, isStandaloneExecutable() ? argv.slice(2) : sourceArgs));
}
const cliArgs = argv.slice(2);

// Keep private runtime entries ahead of helper exposure, browser startup and
// command-registry imports. Static imports execute before top-level dispatch.
if (["--remote-preflight", "--remote-view", "--remote-supervisor", "--remote-model-proof"].includes(cliArgs[0])) {
    try {
        const { runRemoteModelProofEntry, runRemotePreflight, runRemoteView } =
            await import("./shared/remote/entry.ts");
        if (cliArgs.length !== (cliArgs[0] === "--remote-supervisor" ? 2 : 1)) {
            throw new Error("Unexpected remote entry arguments");
        }
        if (cliArgs[0] === "--remote-preflight") await runRemotePreflight();
        else if (cliArgs[0] === "--remote-supervisor") {
            const { runRemoteSupervisor } = await import("./shared/remote/supervisor.ts");
            await runRemoteSupervisor();
        } else if (cliArgs[0] === "--remote-model-proof") await runRemoteModelProofEntry();
        else await runRemoteView();
        // Private entries have no ordinary CLI or personal startup to serve.
        exit(0);
    } catch (error) {
        console.error("[RunWield] Remote entry failed:", error);
        exit(1);
    }
}
const { cleanupAgentBrowserSessionSync, initializeAgentBrowserSession } =
    await import("./shared/agent-browser-session.ts");
const { exposeBundledHelpersSync } = await import("./shared/package-install.ts");

function isProtocolOnlyStartup(argv: string[]): boolean {
    return argv[0] === "mcp" || argv[0] === "remote" || (argv[0] === "--mode" && argv[1] === "acp");
}

if (cliArgs[0] !== "remote") exposeBundledHelpersSync();

if (!isProtocolOnlyStartup(cliArgs)) initializeAgentBrowserSession();

function stripLeadingGlobalFlags(argv: string[]): string[] {
    const stripped: string[] = [];
    let stillInGlobalPrefix = true;

    for (const arg of argv) {
        if (
            stillInGlobalPrefix &&
            (arg === "--help" ||
                arg === "-h" ||
                arg === "--continue" ||
                arg === "-c" ||
                arg === "--version" ||
                arg === "-v")
        ) {
            continue;
        }
        stillInGlobalPrefix = false;
        stripped.push(arg);
    }

    return stripped;
}

function isHelpFlag(arg: string): boolean {
    return arg === "--help" || arg === "-h";
}

function isGlobalFlag(arg: string): boolean {
    return isHelpFlag(arg) || arg === "--continue" || arg === "-c";
}

function resolveHelpRequest(
    argv: string[],
    commandNames: { HELP: string },
): { requested: false } | { requested: true; commandName?: string } {
    if (argv[0] === commandNames.HELP) {
        const commandName = argv.slice(1).find((arg) => !isHelpFlag(arg));
        return commandName ? { requested: true, commandName } : { requested: true };
    }

    if (!argv.some(isHelpFlag)) return { requested: false };

    const commandName = argv.find((arg) => !isGlobalFlag(arg));
    return commandName ? { requested: true, commandName } : { requested: true };
}

async function main(): Promise<void> {
    let allowSystemDirectory = false;
    const args = [...cliArgs];
    // Only consume the acknowledgement in the leading global prefix.
    for (let index = 0; index < args.length; index++) {
        if (args[index] === "--allow-system-directory") {
            allowSystemDirectory = true;
            args.splice(index--, 1);
        } else if (!["--continue", "-c", "--help", "-h", "--version", "-v"].includes(args[index])) break;
    }

    const parsed = parseArgs(args, {
        stopEarly: true,
        boolean: ["help", "continue", "version"],
        string: ["mode"],
        alias: { h: "help", c: "continue", v: "version" },
    });

    const normalizedArgs = stripLeadingGlobalFlags(args);
    const [firstPositional] = parsed._.map(String);

    if (parsed.version) {
        const { runVersionCommand } = await import("./cmd/version/index.ts");
        await runVersionCommand();
        return;
    }

    if (normalizedArgs[0] === "package-smoke" && env.WLD_INTERNAL_PACKAGE_CHECK === "1") {
        const { runPackageSmokeCommand } = await import("./cmd/package-smoke/index.ts");
        await runPackageSmokeCommand(normalizedArgs.slice(1));
        return;
    }

    if (normalizedArgs[0] === "remote") {
        const { runRemoteCommand } = await import("./cmd/remote/index.ts");
        await runRemoteCommand(normalizedArgs.slice(1));
        return;
    }

    if (normalizedArgs[0] === "mcp") {
        const { runMcpCommand } = await import("./cmd/mcp/index.ts");
        await runMcpCommand(normalizedArgs.slice(1));
        return;
    }

    const { COMMAND_NAMES, commandRegistry, getCommandDefinition, hasCommandSurface, requiresProjectDirectoryConsent } =
        await import("./cmd/registry.js");
    const { printCommandHelp, printGlobalHelp } = await import("./cmd/help/index.js");

    const helpRequest = resolveHelpRequest(args, COMMAND_NAMES);
    if (helpRequest.requested) {
        if (!helpRequest.commandName) {
            printGlobalHelp();
            return;
        }
        if (!printCommandHelp(helpRequest.commandName)) {
            console.error(`[RunWield] Unknown command for help: ${helpRequest.commandName}`);
            console.log();
            exit(1);
        }
        return;
    }

    if (parsed.mode === "acp") {
        const acpModeCommandArgs = parsed._.map(String);
        if (acpModeCommandArgs[0] === COMMAND_NAMES.LOGIN) {
            await commandRegistry[COMMAND_NAMES.LOGIN].execute(acpModeCommandArgs.slice(1));
            return;
        }
        const { runAcpCommand } = await import("./cmd/acp/index.ts");
        await runAcpCommand([]);
        return;
    }

    if (firstPositional === COMMAND_NAMES.ACP && normalizedArgs[1] === COMMAND_NAMES.LOGIN) {
        await commandRegistry[COMMAND_NAMES.LOGIN].execute(normalizedArgs.slice(2));
        return;
    }

    // Invalid options cannot start project work and must keep their usage error.
    if (normalizedArgs[0]?.startsWith("-") && normalizedArgs[0] !== "--") {
        console.error(`[RunWield] Unknown option: ${normalizedArgs[0]}`);
        console.error("Use positional commands, for example: wld <command> [args]");
        exit(1);
    }

    if (requiresProjectDirectoryConsent(firstPositional, normalizedArgs.slice(1))) {
        const { confirmProjectDirectory } = await import("./ui/tui/directory-warning.ts");
        const { getCwd } = await import("./constants.js");
        if (!(await confirmProjectDirectory(getCwd(), allowSystemDirectory))) return;
        const { resolvePrimaryCheckoutRoot } = await import("./shared/primary-checkout.ts");
        const primaryRoot = resolvePrimaryCheckoutRoot(getCwd());
        if (primaryRoot !== getCwd() && !(await confirmProjectDirectory(primaryRoot, allowSystemDirectory))) return;
    }

    if (firstPositional === "guided-review") {
        const { createGuidedReviewCliIo, runGuidedReviewCommand } = await import("./cmd/guided-review/index.ts");
        const code = await runGuidedReviewCommand(createGuidedReviewCliIo());
        if (code !== 0) exit(code);
        return;
    }

    if (firstPositional === "plans") {
        const { runPlansCommand } = await import("./cmd/plans/index.ts");
        const [, ...commandArgs] = normalizedArgs;
        await runPlansCommand(commandArgs);
        return;
    }

    const positionalCommand = getCommandDefinition(firstPositional);
    if (positionalCommand) {
        if (!hasCommandSurface(positionalCommand, "cli")) {
            console.error(
                `[RunWield] Command '${firstPositional}' is only available inside interactive chat as /${firstPositional}.`,
            );
            exit(1);
        }
        const [, ...commandArgs] = normalizedArgs;
        await positionalCommand.execute(commandArgs);
        return;
    }

    if (parsed.help) {
        printGlobalHelp();
        return;
    }

    if (normalizedArgs[0]?.startsWith("-")) {
        console.error(`[RunWield] Unknown option: ${normalizedArgs[0]}`);
        console.error("Use positional commands, for example: wld <command> [args]");
        exit(1);
    }

    await commandRegistry[COMMAND_NAMES.ROUTER].execute(normalizedArgs, {
        sessionStartMode: parsed.continue ? "continue" : "new",
    });
}

try {
    await main();
} catch (err) {
    const { DirectoryStartupCanceled } = await import("./ui/tui/directory-warning.ts");
    if (err instanceof DirectoryStartupCanceled) exit(0);
    if (!isProtocolOnlyStartup(cliArgs)) {
        try {
            const { stopTUI } = await import("./ui/tui/tui.ts");
            stopTUI();
        } catch (_error) {
            // Ignore cleanup failures during fatal error reporting.
        }
    }
    if (err instanceof Error && err.message.includes("Mnemoteca binary not found")) {
        console.error(err.message);
    } else {
        console.error("[RunWield] Fatal error:", err);
    }
    cleanupAgentBrowserSessionSync();
    exit(1);
} finally {
    cleanupAgentBrowserSessionSync();
}
