import { withRuntimeCommandFixture } from "../../../cmd/testing/runtime-command-fixture.ts";
import { SessionHost } from "../../../shared/session/session-host.ts";
import { SessionRuntime } from "../../../shared/session/session-runtime.ts";
import { openFileSessionStore } from "../../../shared/session/file-session-store.ts";
import type { HostedSession } from "../../../shared/session/hosted-session.js";
import type { FileSessionStore } from "../../../shared/session/file-session-store-types.ts";

export interface SessionViewFixture {
    runtime: SessionRuntime;
    host: SessionHost;
    sessionId: string;
    session: HostedSession;
    store: FileSessionStore;
    projectRoot: string;
}

/** Real Session owner and file bundle; only the model/environment are scripted. */
export async function withSessionViewFixture(run: (fixture: SessionViewFixture) => void | Promise<void>) {
    await withRuntimeCommandFixture("session-view-", async ({ projectRoot }) => {
        const host = new SessionHost();
        const store = openFileSessionStore();
        const runtime = new SessionRuntime({
            sessionHost: host,
            sessionStore: store,
            ownsSessionStore: true,
            ownerProcessKind: "test",
            ownerInstanceId: crypto.randomUUID(),
        });
        try {
            const { sessionId } = await runtime.createInteractiveSession({ cwd: projectRoot });
            await run({ runtime, host, sessionId, session: host.requireSession(sessionId), store, projectRoot });
        } finally {
            await runtime.closeAllSessions();
        }
    });
}
