import type { HostedSession } from "../hosted-session.js";

interface BackgroundSteeringOwner {
    clearBackgroundSteering(session: HostedSession): Promise<void>;
}

// Only a runtime that owns a Session can have queued background steering for it.
const owners = new WeakMap<HostedSession, BackgroundSteeringOwner>();

export function registerBackgroundSteeringOwner(session: HostedSession, owner: BackgroundSteeringOwner): void {
    owners.set(session, owner);
}

export async function clearBackgroundSteeringForCompletion(session: HostedSession): Promise<void> {
    await owners.get(session)?.clearBackgroundSteering(session);
}
