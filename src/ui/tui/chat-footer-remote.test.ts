import { test } from "node:test";
import { rename as fsRename } from "node:fs/promises";
import { assertStringIncludes, assertThrows } from "../../testing/assertions.ts";
import { join } from "node:path";
import { getHomeDir } from "../../constants.js";
import { configureRemotePersonalResources, PersonalResourcePathError } from "../../shared/remote/personal-resources.ts";
import { getSettingsManager } from "../../shared/settings.js";
import { createChatFooterController } from "./chat-footer.ts";
import { withSessionViewFixture } from "./testing/session-view-fixture.ts";

// Remote personal roots are process-lifetime state. Keep this mount-loss case
// in its own test file so the isolated runner cannot affect other fixtures.
test("live footer retains its selected model when unused personal defaults become unavailable", async () => {
    await withSessionViewFixture(async ({ runtime, host, sessionId, session, projectRoot }) => {
        session.resetAgentInfoStack("Router", "selected-model", "selected-provider", "router");
        const qualified = await runtime.createInteractiveSession({ cwd: projectRoot });
        host.requireSession(qualified.sessionId).resetAgentInfoStack(
            "Router",
            "selected-provider/selected-model",
            "",
            "router",
        );
        const controllers = [sessionId, qualified.sessionId].map((id) =>
            createChatFooterController({
                runtime,
                getSessionId: () => id,
                requestRender: () => {},
            }),
        );
        const mounted = join(getHomeDir(), ".wld");
        const detached = join(getHomeDir(), "detached-personal-root");
        let mountRemoved = false;
        const realNow = Date.now;
        const now = realNow();
        Date.now = () => now;
        try {
            for (const controller of controllers) {
                assertStringIncludes(controller.component.render(120).join("\n"), "selected-provider/selected-model");
            }
            configureRemotePersonalResources({ globalRoot: mounted });
            await fsRename(mounted, detached);
            mountRemoved = true;
            // Prove this is a real unavailable default, not a permissive fixture.
            assertThrows(() => getSettingsManager(projectRoot).getDefaultModel(), PersonalResourcePathError);
            // Hold the clock inside the existing snapshot window: a snapshot
            // refresh has its own required compaction-settings read.
            for (const controller of controllers) {
                assertStringIncludes(controller.component.render(120).join("\n"), "selected-provider/selected-model");
            }
        } finally {
            if (mountRemoved) await fsRename(detached, mounted);
            for (const controller of controllers) controller.dispose();
            Date.now = realNow;
        }
    });
});
