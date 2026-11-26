/** A new user turn cannot start while the Session already owns an active turn. */
export class SessionTurnInProgressError extends Error {
    readonly sessionId: string;

    constructor(sessionId: string) {
        super(`Session "${sessionId}" already has an active turn`);
        this.name = "SessionTurnInProgressError";
        this.sessionId = sessionId;
    }
}
