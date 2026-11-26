import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { remotePersonalResourcesActive } from "@runwield/resources/personal";

/** Pi provider hooks cannot execute across the remote model transport. */
const REMOTE_PROVIDER_EXTENSION_OPTIONS = new Map([
    ["before_provider_request", "onPayload"],
    ["before_provider_headers", "transformHeaders"],
    ["after_provider_response", "onResponse"],
    ["provider_stream_event", "onProviderStreamEvent"],
]);

export function assertRemoteProviderExtensionsSupported(session: AgentSession) {
    if (!remotePersonalResourcesActive()) return;
    for (const [event, option] of REMOTE_PROVIDER_EXTENSION_OPTIONS) {
        if (session.hasExtensionHandlers(event)) {
            throw new Error(`Unsupported remote model option: ${option} (extension event: ${event})`);
        }
    }
}
