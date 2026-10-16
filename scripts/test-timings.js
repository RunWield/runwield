import {
    mkdir as fsMkdir,
    readFile as fsReadFile,
    rename as fsRename,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname, relative } from "node:path";

const TIMING_FILE_VERSION = 1;
// A timing changes order, never membership or assertions. Use the first real
// observation instead of leaving long files at the end for two further runs.
const MINIMUM_SCHEDULING_RUNS = 1;

/**
 * @typedef {Object} TestTiming
 * @property {number} durationMs
 * @property {number} runs
 */

/**
 * @typedef {Object} TestTimingFile
 * @property {number} version
 * @property {Record<string, TestTiming>} files
 */

/** @param {string} path @returns {Promise<Record<string, TestTiming>>} */
export async function readTestTimings(path) {
    try {
        const parsed = JSON.parse(await fsReadFile(path, "utf8"));
        if (parsed?.version !== TIMING_FILE_VERSION || !parsed.files || Array.isArray(parsed.files)) return {};
        /** @type {Record<string, TestTiming>} */
        const timings = {};
        for (const [file, timing] of Object.entries(parsed.files)) {
            if (
                timing && typeof timing === "object" && !Array.isArray(timing) &&
                typeof timing.durationMs === "number" && timing.durationMs >= 0 &&
                typeof timing.runs === "number" && timing.runs > 0
            ) {
                timings[file] = { durationMs: timing.durationMs, runs: timing.runs };
            }
        }
        return timings;
    } catch (error) {
        if ((error instanceof Error && "code" in error && error.code === "ENOENT")) return {};
        console.error(
            `[tests] ignored invalid timing history ${path}: ${error instanceof Error ? error.message : error}`,
        );
        return {};
    }
}

/**
 * Put historically slow files first. Unknown files use the known median so new
 * tests do not collect at either end of the queue.
 *
 * @param {string[]} files
 * @param {string} root
 * @param {Record<string, TestTiming>} timings
 * @returns {string[]}
 */
export function orderTestsByTiming(files, root, timings) {
    const trusted = Object.values(timings).filter((timing) => timing.runs >= MINIMUM_SCHEDULING_RUNS);
    const known = trusted.map((timing) => timing.durationMs).sort((a, b) => a - b);
    const fallback = known.length ? known[Math.floor(known.length / 2)] : 0;
    return [...files].sort((left, right) => {
        const leftName = relative(root, left);
        const rightName = relative(root, right);
        const leftTiming = timings[leftName];
        const rightTiming = timings[rightName];
        const leftDuration = leftTiming && leftTiming.runs >= MINIMUM_SCHEDULING_RUNS
            ? leftTiming.durationMs
            : fallback;
        const rightDuration = rightTiming && rightTiming.runs >= MINIMUM_SCHEDULING_RUNS
            ? rightTiming.durationMs
            : fallback;
        const durationDifference = rightDuration - leftDuration;
        return durationDifference || leftName.localeCompare(rightName);
    });
}

/**
 * Merge one run into history. Recent data has one quarter of the weight so a
 * transient slow runner does not reorder the whole suite.
 *
 * @param {Record<string, TestTiming>} previous
 * @param {Array<{ file: string, durationMs: number }>} observed
 * @returns {Record<string, TestTiming>}
 */
export function mergeTestTimings(previous, observed) {
    const merged = { ...previous };
    for (const { file, durationMs } of observed) {
        const old = previous[file];
        merged[file] = {
            durationMs: old ? Math.round(old.durationMs * 0.75 + durationMs * 0.25) : durationMs,
            runs: (old?.runs || 0) + 1,
        };
    }
    return merged;
}

/** @param {string} path @param {Record<string, TestTiming>} files */
export async function writeTestTimings(path, files) {
    await fsMkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
    /** @type {TestTimingFile} */
    const payload = { version: TIMING_FILE_VERSION, files };
    await fsWriteFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`);
    await fsRename(temporaryPath, path);
}
