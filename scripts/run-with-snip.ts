#!/usr/bin/env bun
import { captureScriptProcess, type ScriptProcessOutput } from "./script-process.ts";
import { writeFile as fsWriteFile } from "node:fs/promises";
import process from "node:process";

import { makeTempFile } from "../src/testing/temp-file.ts";
import { basename } from "node:path";

export interface SnipCommandOptions {
    cwd?: string;
    env?: Record<string, string>;
    failureLabel: string;
    stdin?: "inherit" | "null";
    quietOnSuccess?: boolean;
}

export interface SnipCommandResult {
    code: number;
    stdout: string;
    stderr: string;
    failureLogPath?: string;
}

const PASSING_DENO_OUTPUT = [
    /^Check .+$/,
    /^Checked \d+ files?$/,
    /^running \d+ tests? from .+$/,
    /^.+ \.\.\. ok(?: \(.+\))?$/,
    /^ok \| \d+ passed \| 0 failed.*$/,
];

function withoutSnipNoise(output: string): string {
    return output
        .split("\n")
        .filter((line) => !line.startsWith("snip: tracking error:"))
        .filter((line) => !line.startsWith("snip: no filter for "))
        .join("\n");
}

/** Keep only diagnostics when a Deno validation command fails. */
export function extractDenoFailureOutput(command: string, args: string[], output: string): string {
    if (basename(command) !== "deno" || !["check", "fmt", "lint", "test"].includes(args[0] || "")) {
        return withoutSnipNoise(output).trim();
    }

    return withoutSnipNoise(output)
        .split("\n")
        .filter((line) => !PASSING_DENO_OUTPUT.some((pattern) => pattern.test(line)))
        .map((line) => line.replace(/^FAILED \| \d+ passed \| ([1-9]\d*) failed/, "FAILED | $1 failed"))
        .join("\n")
        .replace(/^\s+|\s+$/g, "");
}

function failureLogPrefix(label: string): string {
    const slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    return `${slug || "command"}-failure-`;
}

/** Run one command through Snip and replace failed output with a filtered log pointer. */
export async function runWithSnip(
    command: string,
    args: string[],
    options: SnipCommandOptions,
): Promise<SnipCommandResult> {
    const env = {
        ...{ ...process.env },
        ...options.env,
        // Snip's tee stores raw output. Plan 3 stores filtered diagnostics instead.
        SNIP_TEE: "0",
    };
    const result = await captureScriptProcess("snip", {
        args: [command, ...args],
        cwd: options.cwd,
        env,
        stdin: options.stdin ?? "null",
        stdout: "piped",
        stderr: "piped",
    });
    return await formatCommandResult(command, args, options, result);
}

async function formatCommandResult(
    command: string,
    args: string[],
    options: SnipCommandOptions,
    result: ScriptProcessOutput,
): Promise<SnipCommandResult> {
    const decoder = new TextDecoder();
    const stdout = decoder.decode(result.stdout);
    const stderr = decoder.decode(result.stderr);

    if (result.success) {
        return options.quietOnSuccess
            ? { code: 0, stdout: "", stderr: "" }
            : { code: 0, stdout, stderr: withoutSnipNoise(stderr) };
    }

    const filtered =
        extractDenoFailureOutput(command, args, `${stdout}${stderr}`) ||
        `${options.failureLabel} failed with exit code ${result.code}.`;
    const failureLogPath = await makeTempFile({ prefix: failureLogPrefix(options.failureLabel), suffix: ".log" });
    await fsWriteFile(failureLogPath, `${filtered}\n`);

    return {
        code: result.code,
        stdout: "",
        stderr: `${options.failureLabel} failed, read the failure log here: ${failureLogPath}\n`,
        failureLogPath,
    };
}

async function testTimeoutResult(timeoutMs: number): Promise<SnipCommandResult> {
    const failureLogPath = await makeTempFile({ prefix: "tests-timeout-", suffix: ".log" });
    await fsWriteFile(failureLogPath, `Test process exceeded ${timeoutMs / 1000}s and was stopped.\n`);
    return {
        code: 124,
        stdout: "",
        stderr: `tests timed out, read the failure log here: ${failureLogPath}\n`,
        failureLogPath,
    };
}

// Run the test process itself, not Snip: stopping a Snip wrapper leaves its test child alive.
export async function runBoundedTest(
    args: string[],
    options: SnipCommandOptions & { timeoutMs: number; command?: string; clearEnv?: boolean },
): Promise<SnipCommandResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, options.timeoutMs);
    try {
        const result = await captureScriptProcess(options.command ?? process.execPath, {
            args,
            cwd: options.cwd,
            env: options.clearEnv ? options.env : { ...process.env, ...options.env },
            clearEnv: options.clearEnv,
            stdin: options.stdin ?? "null",
            stdout: "piped",
            stderr: "piped",
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (timedOut) return await testTimeoutResult(options.timeoutMs);
        return await formatCommandResult(options.command ?? process.execPath, args, options, result);
    } catch (error) {
        if (!timedOut) throw error;
        return await testTimeoutResult(options.timeoutMs);
    } finally {
        clearTimeout(timer);
    }
}

export async function writeSnipCommandResult(result: SnipCommandResult): Promise<void> {
    if (result.stdout) {
        await new Promise<void>((resolve, reject) =>
            process.stdout.write(result.stdout, (error) => (error ? reject(error) : resolve())),
        );
    }
    if (result.stderr) {
        await new Promise<void>((resolve, reject) =>
            process.stderr.write(result.stderr, (error) => (error ? reject(error) : resolve())),
        );
    }
}

if (import.meta.main) {
    const separator = process.argv.slice(2).indexOf("--");
    const failureLabel = separator > 0 ? process.argv.slice(2).slice(0, separator).join(" ") : "command";
    const command = separator >= 0 ? process.argv.slice(2)[separator + 1] : undefined;
    const args = separator >= 0 ? process.argv.slice(2).slice(separator + 2) : [];
    if (!command) {
        console.error("usage: run-with-snip <failure label> -- <command> [args...]");
        process.exit(64);
    }

    const result = await runWithSnip(command, args, { failureLabel, stdin: "inherit" });
    await writeSnipCommandResult(result);
    process.exit(result.code);
}
