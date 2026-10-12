import { assertEquals, assertStringIncludes } from "@std/assert";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";
import { emitHostedSessionRuntimeEvent, type RuntimeUsage } from "../../shared/session/session-runtime-events.js";
import { createChatFooterController } from "./chat-footer.ts";
import { initRunWieldTheme } from "../theme/theme.js";

initRunWieldTheme();

const absent: RuntimeUsage = {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costUsd: null,
};

Deno.test("footer shows unavailable categories before a measurement", async () => {
    await withSessionViewFixture(({ runtime, sessionId }) => {
        const controller = createChatFooterController({
            runtime,
            getSessionId: () => sessionId,
            requestRender: () => {},
        });
        try {
            const text = controller.component.render(200).join("\n");
            for (const label of ["↑—", "↓—", "R—", "W—", "$—"]) assertStringIncludes(text, label);
        } finally {
            controller.dispose();
        }
    });
});

Deno.test("footer preserves present values and measured zero beside unavailable categories", async () => {
    await withSessionViewFixture(({ runtime, sessionId, session }) => {
        const controller = createChatFooterController({
            runtime,
            getSessionId: () => sessionId,
            requestRender: () => {},
        });
        try {
            emitHostedSessionRuntimeEvent(session, {
                type: "usage",
                usage: { ...absent, inputTokens: 12, outputTokens: 0 },
            });
            emitHostedSessionRuntimeEvent(session, { type: "usage", usage: absent });
            const text = controller.component.render(200).join("\n");
            for (const label of ["↑12", "↓0", "R—", "W—", "$—"]) assertStringIncludes(text, label);
            assertEquals(text.includes("$0.000"), false);
        } finally {
            controller.dispose();
        }
    });
});

Deno.test("footer shows reported zero cost and sums only measured values", async () => {
    await withSessionViewFixture(({ runtime, sessionId, session }) => {
        const controller = createChatFooterController({
            runtime,
            getSessionId: () => sessionId,
            requestRender: () => {},
        });
        try {
            emitHostedSessionRuntimeEvent(session, {
                type: "usage",
                usage: { ...absent, inputTokens: 12, costUsd: 0 },
            });
            emitHostedSessionRuntimeEvent(session, { type: "usage", usage: { ...absent, inputTokens: 8 } });
            const text = controller.component.render(200).join("\n");
            assertStringIncludes(text, "↑20");
            assertStringIncludes(text, "$0.000");
        } finally {
            controller.dispose();
        }
    });
});
