import { readFile as fsReadFile } from "node:fs/promises";
import { test } from "node:test";
import { assertEquals } from "../../src/testing/assertions.ts";
interface UsageExcerpt {
    fixture: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: null;
}
interface ExcerptFile {
    rows: UsageExcerpt[];
}
interface VendorUsage {
    input_tokens: number;
    output_tokens: number;
    thinking_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens?: number;
}
interface VendorResult {
    usage: VendorUsage;
}
interface VendorEvent {
    event: string;
    result?: VendorResult;
}
const excerpts: ExcerptFile = JSON.parse(
    await fsReadFile(new URL("./fixtures/agy-usage.json", import.meta.url), "utf8"),
);
for (const excerpt of excerpts.rows) {
    test(`sanitized partial fixture matches the recorded agy result: ${excerpt.fixture}`, async () => {
        const text = await fsReadFile(
            new URL(`../../src/shared/session/backends/agy-cli/fixtures/${excerpt.fixture}`, import.meta.url),
            "utf8",
        );
        const events: VendorEvent[] = text
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        const usage = events.find((event) => event.event === "result")!.result!.usage;
        assertEquals(
            {
                inputTokens: excerpt.inputTokens,
                outputTokens: excerpt.outputTokens,
                reasoningTokens: excerpt.reasoningTokens,
                cacheReadTokens: excerpt.cacheReadTokens,
                cacheWriteTokens: excerpt.cacheWriteTokens,
            },
            {
                inputTokens: usage.input_tokens,
                outputTokens: usage.output_tokens,
                reasoningTokens: usage.thinking_tokens,
                cacheReadTokens: usage.cache_read_tokens,
                cacheWriteTokens: usage.cache_write_tokens ?? null,
            },
        );
    });
}
