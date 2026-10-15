import { FileSessionStoreOwner } from "../file-session-store-owner.ts";
import { RemoteSessionPersistence } from "./remote-persistence.ts";
import type { SessionRuntimeComposition } from "./types.ts";

export class RuntimeServices {
    readonly sessionHost;
    readonly sessionStoreOwner;
    readonly remotePersistence;
    readonly ownerProcessKind;
    readonly ownerInstanceId;

    constructor(composition: SessionRuntimeComposition) {
        this.sessionHost = composition.sessionHost;
        this.remotePersistence = composition.remoteSessionControl
            ? new RemoteSessionPersistence(composition.remoteSessionControl)
            : null;
        this.sessionStoreOwner = new FileSessionStoreOwner(composition.sessionStore, composition.ownsSessionStore);
        this.ownerProcessKind = composition.ownerProcessKind;
        this.ownerInstanceId = composition.ownerInstanceId;
    }

    get sessionStore() {
        return this.sessionStoreOwner.current();
    }
}
