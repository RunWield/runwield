import {
    mkdir as fsMkdir,
    mkdtemp as fsMkdtemp,
    readFile as fsReadFile,
    rm as fsRm,
    writeFile as fsWriteFile,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
/**
 * Execution Agents each declare one context contract, and tests hold the line
 * between those contracts. The declaration is metadata for diagnostics and
 * regression tests. Runtime workflow state still decides which Agent runs.
 */
import { assertEquals, assertRejects, assertStringIncludes } from "../../testing/assertions.ts";
import { join } from "node:path";
import { SUBAGENTS } from "../../constants.js";
import { isWorkflowOnlyAgent, listAllAgentDefinitions, listAvailableAgents, loadAgentDef } from "./agents.js";
import { loadSubAgentDefinition } from "./subagent-definitions.ts";

const EXECUTION_CONTRACTS: ReadonlyArray<{
    agentName: string;
    displayName: string;
    loader: "agent" | "subagent";
    contextContract: "quick-fix" | "plan-execution" | "frontend-plan-execution" | "validation-repair";
    sharedPractice: readonly string[];
    requiredLanguage: readonly string[];
    forbiddenLanguage: readonly string[];
    workflowOnly: boolean | null;
    discoverable: boolean;
}> = [
    {
        agentName: "engineer",
        displayName: "Engineer",
        loader: "agent",
        contextContract: "quick-fix",
        sharedPractice: ["user-authority", "working-tree-safety", "engineering-practice", "bounded-request"],
        requiredLanguage: [
            "QUICK_FIX",
            "Quick Fix Checklist",
            "Mechanical Validation",
            "Load the Skill that covers the domain",
            "Browser UI means the frontend and browser Skills",
            "`web_docs_search`",
        ],
        forbiddenLanguage: [
            "approved Planned Change Plan",
            "Validation Continuation",
            "Pair Execution is active",
            "pair_checkpoint",
        ],
        workflowOnly: false,
        discoverable: true,
    },
    {
        agentName: "plan-engineer",
        displayName: "Plan Engineer",
        loader: "agent",
        contextContract: "plan-execution",
        sharedPractice: ["user-authority", "working-tree-safety", "engineering-practice", "plan-execution"],
        requiredLanguage: [
            "approved Planned Change Plan",
            "A Validation Continuation",
            "Runtime Collaboration Style",
            "pair_checkpoint",
            "record_plan_deviation",
            "Implementation Steps",
        ],
        forbiddenLanguage: ["QUICK_FIX", "Quick Fix Checklist", "One Task at a Time, With Elastic Edges"],
        workflowOnly: true,
        discoverable: false,
    },
    {
        agentName: "frontend-engineer",
        displayName: "Frontend Engineer",
        loader: "agent",
        contextContract: "frontend-plan-execution",
        sharedPractice: ["user-authority", "working-tree-safety", "engineering-practice", "plan-execution"],
        requiredLanguage: [
            "approved Plan",
            "headed browser",
            "browserPreflightOutcome",
            "visible evidence",
            "Runtime Collaboration Style",
            "record_plan_deviation",
        ],
        forbiddenLanguage: ["QUICK_FIX", "Quick Fix Checklist", "One Task at a Time, With Elastic Edges"],
        workflowOnly: true,
        discoverable: false,
    },
    {
        agentName: "reviewer-feedback-engineer",
        displayName: "Validation Repair Engineer",
        loader: "subagent",
        contextContract: "validation-repair",
        sharedPractice: ["working-tree-safety", "engineering-practice"],
        requiredLanguage: [
            "You receive one bounded repair packet",
            "Do not reconstruct the",
            "Report per item",
        ],
        forbiddenLanguage: ["approved Planned Change Plan", "Quick Fix Checklist", "Pair Execution is active"],
        workflowOnly: null,
        discoverable: false,
    },
];

async function loadContractDef(agentName: string, loader: "agent" | "subagent") {
    if (loader === "subagent") return await loadSubAgentDefinition(SUBAGENTS.REVIEWER_FEEDBACK_ENGINEER);
    return await loadAgentDef(agentName);
}

/**
 * Read frontmatter declarations straight from the bundled definition file.
 * Merged prompts cannot answer this: fragments can create overlapping text, so
 * the declaration is what says which contract an Agent claims.
 */
async function readBundledFrontMatter(agentName: string, loader: "agent" | "subagent"): Promise<Map<string, string[]>> {
    const filePath = loader === "subagent"
        ? join("src", "agent-definitions", "subagent-definitions", `${agentName}.md`)
        : join("src", "agent-definitions", `${agentName}.md`);
    const contents = await fsReadFile(filePath, "utf8");
    const result = new Map<string, string[]>();
    const scalarMatches = contents.match(/^---\n([\s\S]*?)\n---/m)?.[1] || "";
    let currentList = "";
    for (const line of scalarMatches.split("\n")) {
        const scalar = line.match(/^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/);
        if (scalar) {
            currentList = scalar[1];
            const value = scalar[2]?.trim();
            if (value) result.set(currentList, [value.replace(/^"|"$/g, "")]);
            else result.set(currentList, []);
            continue;
        }
        const listItem = line.match(/^\s+-\s*(.+)$/);
        if (listItem && currentList) {
            result.set(currentList, [...(result.get(currentList) || []), listItem[1].trim()]);
        }
    }
    return result;
}

test("declared context contracts and prompt boundaries", async () => {
    const selectable = (await listAvailableAgents()).map((agent) => agent.name);
    const allTopLevel = (await listAllAgentDefinitions()).map((agent) => agent.name);

    for (const contract of EXECUTION_CONTRACTS) {
        const def = await loadContractDef(contract.agentName, contract.loader);
        const frontMatter = await readBundledFrontMatter(contract.agentName, contract.loader);

        assertEquals(def.displayName, contract.displayName, `${contract.agentName} display name drifted`);
        assertEquals(def.contextContract, contract.contextContract, `${contract.agentName} loaded wrong contract`);
        assertEquals(
            frontMatter.get("contextContract"),
            [contract.contextContract],
            `${contract.agentName} declares wrong contextContract`,
        );
        assertEquals(
            frontMatter.get("sharedPractice") || [],
            [...contract.sharedPractice],
            `${contract.agentName} shared practice drifted`,
        );

        for (const phrase of contract.requiredLanguage) {
            assertStringIncludes(def.systemPrompt, phrase, `${contract.agentName} lost required phrase: ${phrase}`);
        }
        for (const phrase of contract.forbiddenLanguage) {
            assertEquals(
                def.systemPrompt.includes(phrase),
                false,
                `${contract.agentName} carries forbidden cross-contract phrase: ${phrase}`,
            );
        }

        if (contract.workflowOnly !== null) {
            assertEquals(def.workflowOnly, contract.workflowOnly, `${contract.agentName} workflowOnly drifted`);
            assertEquals(
                await isWorkflowOnlyAgent(contract.agentName),
                contract.workflowOnly,
                `${contract.agentName} workflow-only query drifted`,
            );
            assertEquals(
                allTopLevel.includes(contract.agentName),
                true,
                `${contract.agentName} must remain loadable as a top-level Agent`,
            );
        }
        assertEquals(
            selectable.includes(contract.agentName),
            contract.discoverable,
            `${contract.agentName} discoverability drifted`,
        );
    }
});

test("Plan execution agents declare the Plan Deviation tool", async () => {
    for (const name of ["plan-engineer", "frontend-engineer"]) {
        const definition = await loadAgentDef(name);
        assertEquals(definition.tools.includes("record_plan_deviation"), true, `${name} needs Plan Deviation access`);
    }
});

test("project overrides may not silently invent a context contract", async () => {
    const projectRoot = await fsMkdtemp(join(tmpdir(), "runwield-agent-contracts-"));
    try {
        const agentsDir = join(projectRoot, ".wld", "agents");
        await fsMkdir(agentsDir, { recursive: true });

        await fsWriteFile(join(agentsDir, "engineer.md"), "---\nworkflowOnly: true\n---\n\nOverride body.\n");
        const inherited = await loadAgentDef("engineer", projectRoot);
        assertEquals(inherited.contextContract, "quick-fix");
        assertEquals(inherited.workflowOnly, true);

        await fsWriteFile(
            join(agentsDir, "engineer.md"),
            "---\ncontextContract: plan-execution\n---\n\nOverride body.\n",
        );
        const relabeled = await loadAgentDef("engineer", projectRoot);
        assertEquals(relabeled.contextContract, "plan-execution");
        assertEquals(relabeled.name, "engineer", "contextContract must not become runtime identity");

        await fsWriteFile(
            join(agentsDir, "engineer.md"),
            "---\ncontextContract: launch-authority\n---\n\nOverride body.\n",
        );
        await assertRejects(
            () => loadAgentDef("engineer", projectRoot),
            Error,
            "invalid contextContract",
        );
    } finally {
        await fsRm(projectRoot, { recursive: true });
    }
});

test("static prompt baseline is recorded as comparison data only", async () => {
    const baselines = [];
    for (const contract of EXECUTION_CONTRACTS) {
        const def = await loadContractDef(contract.agentName, contract.loader);
        const characters = def.systemPrompt.length;
        baselines.push({ agentName: contract.agentName, characters, roughTokens: Math.round(characters / 4) });
        assertEquals(characters > 1000, true, `${contract.agentName} prompt baseline unexpectedly empty`);
    }
    console.info(
        `Static execution prompt baseline, not full per-turn cost: ${JSON.stringify(baselines)}`,
    );
});
