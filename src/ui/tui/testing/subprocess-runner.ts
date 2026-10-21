import { env as processEnv, execPath } from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { getCwd } from "../../../constants.js";
import { type NativeSpawnOptions, spawnNativeProcess } from "../../../shared/foreground-process.ts";
/**
 * @module ui/tui/testing/subprocess-runner
 * Bounded subprocess runner used by Golden TUI scenarios.
 */

export interface GoldenChildResult {
    success: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

export interface GoldenChildOptions {
    cwd?: string;
    env?: NativeSpawnOptions["env"];
    timeoutMs?: number;
    startupTimeoutMs?: number;
    awaitReadyMarker?: boolean;
    terminationGraceMs?: number;
}

type TextObserver = (text: string) => void;

const SECRET_ENV_PATTERNS = [/API_KEY/i, /TOKEN/i, /AUTH/i, /SECRET/i, /PASSWORD/i];

/**
 * Booting a child Deno process and loading the RunWield module graph costs
 * seconds, and that cost balloons on a loaded CI runner. Budget it separately
 * from the scenario itself so scenario timeouts stay meaningful: exceeding this
 * means the child never got off the ground, not that the scenario was slow.
 */
const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;

/**
 * How long a timed-out child gets to tear itself down before the runner stops
 * asking. The child owns an isolated environment (a fake HOME plus a git
 * fixture) that only it knows how to remove, and SIGKILL cannot be trapped, so
 * killing outright stranded that directory on every timeout.
 */
const DEFAULT_TERMINATION_GRACE_MS = 3_000;

/**
 * Line the child prints once it is ready to execute scenario actions. Seeing it
 * hands the deadline over from the startup budget to the scenario budget.
 */
export const GOLDEN_CHILD_READY_MARKER = "__golden-tui-child-ready__";

/** Notify onText with the full text decoded so far. */
async function readStream(stream: ReadableStream<Uint8Array>, onText?: TextObserver) {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of stream) {
        text += decoder.decode(chunk, { stream: true });
        onText?.(text);
    }
    return text + decoder.decode();
}

export function sanitizeGoldenChildEnv(env: NodeJS.ProcessEnv = processEnv) {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || SECRET_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue;
        sanitized[key] = value;
    }
    return sanitized;
}

/**
 * `timeoutMs` bounds the scenario. When `awaitReadyMarker` is set the clock does
 * not start until the child announces readiness, so a slow boot cannot consume
 * the scenario's budget; until then the looser `startupTimeoutMs` applies.
 *
 */
export async function runGoldenChild(args: string[], options: GoldenChildOptions = {}): Promise<GoldenChildResult> {
    const child = spawnNativeProcess(execPath, {
        args,
        cwd: options.cwd ?? getCwd(),
        stdin: "null",
        env: { ...sanitizeGoldenChildEnv(), ...(options.env || {}) },
        stdout: "piped",
        stderr: "piped",
    });
    const scenarioTimeoutMs = options.timeoutMs || 5000;
    let timedOut = false;
    let escalation: ReturnType<typeof setTimeout> | null = null;
    const kill = () => {
        timedOut = true;
        // Signal first so the child's termination handler can remove its isolated
        // environment, then escalate for a child too wedged to answer. Going
        // straight to SIGKILL leaked the whole fixture directory every timeout.
        try {
            child.kill("SIGTERM");
        } catch {
            // Process may have already exited.
            return;
        }
        escalation = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            } catch {
                // Process exited during the grace window, which is the good case.
            }
        }, options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
        escalation.unref();
    };
    let ready = !options.awaitReadyMarker;
    const startupTimeoutMs = options.startupTimeoutMs || DEFAULT_STARTUP_TIMEOUT_MS;
    let timeout = setTimeout(kill, ready ? scenarioTimeoutMs : startupTimeoutMs);
    const stdout = readStream(child.stdout, (text) => {
        if (ready || !text.includes(GOLDEN_CHILD_READY_MARKER)) return;
        ready = true;
        clearTimeout(timeout);
        timeout = setTimeout(kill, scenarioTimeoutMs);
    });
    const stderr = readStream(child.stderr);
    try {
        const status = await child.status;
        return {
            success: status.success,
            code: status.code,
            stdout: await stdout,
            stderr: await stderr,
            timedOut,
        };
    } finally {
        clearTimeout(timeout);
        if (escalation !== null) clearTimeout(escalation);
    }
}
