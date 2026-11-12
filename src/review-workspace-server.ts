/**
 * @module review-workspace-server
 * Composition adapter connecting shared review workflows to the Workspace UI.
 */

import { startReviewWorkspaceServer as startWorkspaceServer } from "./shared/browser-host/standalone.ts";

export function startReviewWorkspaceServer(
    options: Parameters<typeof startWorkspaceServer>[0],
): ReturnType<typeof startWorkspaceServer> {
    return startWorkspaceServer(options);
}
