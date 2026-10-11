import { assertEquals } from "@std/assert";
import { AcpSessionMap } from "./session-map.ts";

Deno.test("ACP identity remains bound to runwieldSessionId rather than the current piSessionId", () => {
    const sessionMap = new AcpSessionMap();
    const runwieldSessionId = "runwield-session-1";
    const firstPiSessionId = "pi-segment-1";
    const secondPiSessionId = "pi-segment-2";
    sessionMap.createRecord({ sessionId: "runtime-1", cwd: "/repo" }, {
        acpSessionId: `acp-${runwieldSessionId}`,
        persistedSessionId: runwieldSessionId,
        sessionPath: `/repo/.wld/${firstPiSessionId}.jsonl`,
    });

    assertEquals(sessionMap.getAcpSessionIdForRuntimeSession("runtime-1"), `acp-${runwieldSessionId}`);
    assertEquals(sessionMap.getAcpSessionIdForRuntimeSession(firstPiSessionId), null);
    const record = sessionMap.getRecord(`acp-${runwieldSessionId}`);
    assertEquals(record?.persistedSessionId, runwieldSessionId);
    assertEquals(record?.acpSessionId.includes(secondPiSessionId), false);
});
