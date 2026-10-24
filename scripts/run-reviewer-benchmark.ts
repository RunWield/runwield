import { parseArgs } from "node:util";
import { runBenchmark, selectCases } from "./reviewer-benchmark/run.ts";
import { scoreRun } from "./reviewer-benchmark/score.ts";

const usage = `Reviewer-only baseline smoke benchmark (one trial per case)

bun scripts/run-reviewer-benchmark.ts run [options]
  --scenarios smoke|RV-D04,RV-D05|RV-D04/A,RV-D04/B
  --model <provider/model>     Default: effective configured Reviewer
  --timeout-ms <positive-ms>   Default: fixture timeout
  --out <directory>           Default: ~/.wld/reviewer-eval/<run-id>
  --resume                    Requires --out; retries unfinished cases only

bun scripts/run-reviewer-benchmark.ts score <run-directory>
  Writes summary.json and summary.md. Optional human labels: adjudications.json.
  Evidence-path suggestions never earn semantic recall.
`;

export async function main(args: string[]): Promise<void> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        strict: true,
        options: {
            scenarios: { type: "string" },
            model: { type: "string" },
            "timeout-ms": { type: "string" },
            out: { type: "string" },
            resume: { type: "boolean" },
            help: { type: "boolean", short: "h" },
        },
    });
    if (values.help || positionals.length === 0) {
        console.log(usage);
        return;
    }
    if (positionals[0] === "score") {
        if (positionals.length !== 2 || Object.keys(values).length !== 0) throw new Error("Use: score <run-directory>");
        const summary = await scoreRun(positionals[1]);
        console.log(
            `Decision accuracy: ${summary.decisionAccuracy.numerator}/${summary.decisionAccuracy.denominator}; semantic scores: ${summary.semantic.status}`,
        );
        return;
    }
    if (positionals[0] !== "run" || positionals.length !== 1) throw new Error("Use run or score. See --help.");
    const timeoutMs = values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]);
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
        throw new Error("--timeout-ms must be positive");
    const run = await runBenchmark(await selectCases(values.scenarios), {
        model: values.model,
        timeoutMs,
        out: values.out,
        resume: values.resume,
    });
    const completed = new Map(run.results.map((result) => [result.caseId, result]));
    console.log(`Saved ${completed.size}/${run.manifest.cases.length} cases to ${run.directory}`);
    console.log(`Score: bun scripts/run-reviewer-benchmark.ts score ${JSON.stringify(run.directory)}`);
}

if (import.meta.main) {
    try {
        await main(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
