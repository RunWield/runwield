import { test } from "node:test";
import { tmpdir } from "node:os";
import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    stat as fsStat,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { assertEquals, assertRejects } from "../testing/assertions.ts";
import { join } from "node:path";
import { parse as parseJsonc } from "../shared/jsonc.ts";
import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
    createInitVerificationCommandOperation,
    INIT_VERIFICATION_COMMAND_PLACEHOLDER,
} from "./init-verification-command.ts";
import { getCustomSetting } from "../shared/settings.js";

interface InitVerificationCommandParams {
    command?: string;
    verificationNotImplemented?: boolean;
}

interface InitVerificationCommandDetails {
    outcome: "saved" | "rejected";
    verificationCommand?: string;
    reason?: string;
}

const EXTENSION_CONTEXT = {} as ExtensionToolContext;

async function executeTool(
    operation: ReturnType<typeof createInitVerificationCommandOperation>,
    params: InitVerificationCommandParams,
) {
    return await operation.tool.execute(
        "tool-call-1",
        params,
        undefined,
        undefined,
        EXTENSION_CONTEXT,
    ) as AgentToolResult<InitVerificationCommandDetails>;
}

async function readProjectSettings(projectRoot: string) {
    const text = await fsReadFile(join(projectRoot, ".wld", "settings.json"), "utf8");
    return parseJsonc(text) as { verification_command?: string; codereview?: string; nested?: { retained?: boolean } };
}

test("init verification command operation saves a confirmed command in project settings", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "init-verification-command-"));
    const operation = createInitVerificationCommandOperation({ projectRoot });

    const result = await executeTool(operation, { command: "deno task ci" });

    assertEquals(result.details, { outcome: "saved", verificationCommand: "deno task ci" });
    assertEquals(operation.getConfirmedCommand(), "deno task ci");
    assertEquals(getCustomSetting("verification_command", "project", projectRoot), "deno task ci");
    assertEquals((await readProjectSettings(projectRoot)).verification_command, "deno task ci");
});

test("init verification command operation saves the exact placeholder for no implemented verification", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "init-verification-placeholder-"));
    const operation = createInitVerificationCommandOperation({ projectRoot });

    const result = await executeTool(operation, { verificationNotImplemented: true });

    assertEquals(result.details, {
        outcome: "saved",
        verificationCommand: INIT_VERIFICATION_COMMAND_PLACEHOLDER,
    });
    assertEquals(operation.getConfirmedCommand(), INIT_VERIFICATION_COMMAND_PLACEHOLDER);
    assertEquals((await readProjectSettings(projectRoot)).verification_command, INIT_VERIFICATION_COMMAND_PLACEHOLDER);
});

test("init verification command operation preserves unrelated project settings", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "init-verification-preserve-"));
    await fsMkdir(join(projectRoot, ".wld"));
    await fsWriteFile(
        join(projectRoot, ".wld", "settings.json"),
        '{\n  // keep review gate\n  "codereview": "ask",\n  "nested": { "retained": true }\n}\n',
    );
    const operation = createInitVerificationCommandOperation({ projectRoot });

    await executeTool(operation, { command: "npm run verify" });

    assertEquals(await readProjectSettings(projectRoot), {
        codereview: "ask",
        nested: { retained: true },
        verification_command: "npm run verify",
    });
});

test("init verification command operation rejects unresolved outcomes", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "init-verification-reject-"));
    const cases: InitVerificationCommandParams[] = [
        {},
        { command: "   " },
        { command: "deno task ci", verificationNotImplemented: true },
    ];

    for (const params of cases) {
        const operation = createInitVerificationCommandOperation({ projectRoot });
        const result = await executeTool(operation, params);

        assertEquals(result.details.outcome, "rejected");
        assertEquals(operation.getConfirmedCommand(), undefined);
    }

    await assertRejects(
        () => fsStat(join(projectRoot, ".wld", "settings.json")),
        Error,
        "ENOENT",
    );
});
