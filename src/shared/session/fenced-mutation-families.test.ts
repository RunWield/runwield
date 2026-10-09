import { assertEquals } from "@std/assert";
import { SESSION_RUNTIME_METHOD_POLICY } from "./session-runtime-method-policy.ts";

const FENCED_METHOD_DRIVERS: Record<string, string> = {
    clearActiveExecutionWorkflow: "clearActiveExecutionWorkflow(",
    clearQueuedMessages: "clearQueuedMessages(",
    compactSession: "compactSession(",
    cycleSessionThinkingLevel: "cycleSessionThinkingLevel(",
    ensureInitialSessionGeneration: "recoverSessionControl(",
    executePlan: "executePlan(",
    persistSessionImage: "persistSessionImage(",
    promptSession: "promptManagedSession(",
    promptUserTurn: "promptUserTurn(",
    queueNextTurnMessage: "queueNextTurnMessage(",
    recordPlanAssociation: "runManagedStandaloneMutation(",
    requestInteraction: "runManagedStandaloneMutation(",
    reconfigureSessionModel: "reconfigureSessionModel(",
    reloadSession: "reloadSession(",
    renameSession: "renameSession(",
    reopenPlanReview: "runWorkflowOperation(",
    replaceSessionForExecutionFollowUp: "rollManagedSessionSegment(",
    retryWorkRecord: "runWorkflowOperation(",
    reviewSavedPlan: "runManagedStandaloneMutation(",
    rollManagedSessionSegment: "rollSessionTranscriptSegment(",
    runEpicIntegrationGate: "runWorkflowOperation(",
    runLocalShellCommand: "runLocalShellCommand(",
    runPlanAction: "runPlanAction(",
    runPlanningAgent: "runPlanningAgent(",
    runSlicerAgent: "runSlicerAgent(",
    runValidation: "runValidation(",
    setActiveExecutionWorkflow: "setActiveExecutionWorkflow(",
    setProjectStateContext: "setProjectStateContext(",
    setSessionAutoCompaction: "setSessionAutoCompaction(",
    setSessionModel: "setSessionModel(",
    setSessionThinkingLevel: "setSessionThinkingLevel(",
    steerSession: "steerSession(",
    switchAgent: "switchAgent(",
    updateTutorialContext: "runManagedStandaloneMutation(",
};

function methodBody(source: string, methodName: string): string {
    const asyncNeedle = `async ${methodName}(`;
    const syncNeedle = `${methodName}(`;
    const start = source.indexOf(asyncNeedle) >= 0 ? source.indexOf(asyncNeedle) : source.indexOf(syncNeedle);
    if (start < 0) return "";
    const nextDoc = source.indexOf("\n    /**", start + methodName.length);
    return source.slice(start, nextDoc < 0 ? undefined : nextDoc);
}

async function runtimeImplementationSource(): Promise<string> {
    const files: string[] = [];
    for await (const entry of Deno.readDir(new URL("./runtime/", import.meta.url))) {
        if (entry.isFile && entry.name.endsWith(".ts")) files.push(entry.name);
    }
    return (await Promise.all(
        files.sort().map((file) => Deno.readTextFile(new URL(`./runtime/${file}`, import.meta.url))),
    ))
        .join("\n");
}

Deno.test("fenced standalone mutation policy entries all have an explicit Runtime driver", async () => {
    const source = await runtimeImplementationSource();
    const fencedMethods = Object.entries(SESSION_RUNTIME_METHOD_POLICY)
        .filter((entry) => entry[1] === "fenced_standalone_mutation")
        .map((entry) => entry[0])
        .sort();
    const drivenMethods = Object.keys(FENCED_METHOD_DRIVERS).sort();
    assertEquals(drivenMethods, fencedMethods);

    for (const methodName of fencedMethods) {
        const body = methodBody(source, methodName);
        assertEquals(body.length > 0, true, `${methodName} must exist on SessionRuntime`);
        assertEquals(
            body.includes(FENCED_METHOD_DRIVERS[methodName]),
            true,
            `${methodName} must route through ${FENCED_METHOD_DRIVERS[methodName]}`,
        );
    }
});

Deno.test("fenced standalone mutations return a typed managed block result instead of managed_unsupported", async () => {
    const source = await Deno.readTextFile(new URL("./runtime/managed-operations.ts", import.meta.url));
    const rejectionStart = source.indexOf("rejectManagedPublicMutation(");
    const rejectionEnd = source.indexOf("\n    /**", rejectionStart);
    const rejectionBody = source.slice(rejectionStart, rejectionEnd);
    assertEquals(rejectionBody.includes("managed_operation_in_progress"), true);
    assertEquals(rejectionBody.includes("managed_unsupported"), false);
});
