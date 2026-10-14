import { steerAgentSessionWithPreparedInput, steerAgentSessionWithTarget } from ".././session.js";
import { getRuntimeErrorMessage, RuntimeEventTypes } from ".././session-runtime-events.js";

import { getRuntimeRootAgentSession, isRuntimeAgentSession, toRuntimeQueuedMessage } from "./support.ts";
import type { RuntimeAgentSession } from "./support.ts";
import type { QueueSourceSubscription, RuntimeQueuedMessageState } from "./types.ts";

import type { RuntimeServices } from "./base.ts";
import type { RuntimeEvents } from "./events.ts";
import type { RuntimeImages } from "./images.ts";
import type { RuntimeManagedOperations } from "./managed-operations.ts";
import type { RuntimeManagedSync } from "./managed-sync.ts";
import type { RuntimeTurns } from "./turns.ts";

type RuntimeEventsDependency = Pick<RuntimeEvents, "emitSessionEvent">;
type RuntimeImagesDependency = Pick<RuntimeImages, "prepareSteeringInputForAgentSession">;
type RuntimeManagedOperationsDependency = Pick<
    RuntimeManagedOperations,
    "currentCapability" | "hasOperation" | "rejectManagedPublicMutation" | "runManagedStandaloneMutation"
>;
type RuntimeManagedSyncDependency = Pick<RuntimeManagedSync, "synchronizeManagedSession">;
type RuntimeTurnsDependency = Pick<RuntimeTurns, "promptUserTurn">;

export class RuntimeQueues {
    private events!: RuntimeEventsDependency;
    private images!: RuntimeImagesDependency;
    private managedOperations!: RuntimeManagedOperationsDependency;
    private sync!: RuntimeManagedSyncDependency;
    private turns!: RuntimeTurnsDependency;

    constructor(private readonly services: RuntimeServices) {}

    connect(
        events: RuntimeEventsDependency,
        images: RuntimeImagesDependency,
        managedOperations: RuntimeManagedOperationsDependency,
        sync: RuntimeManagedSyncDependency,
        turns: RuntimeTurnsDependency,
    ) {
        this.events = events;
        this.images = images;
        this.managedOperations = managedOperations;
        this.sync = sync;
        this.turns = turns;
    }
    private queuedMessages = new Map<string, RuntimeQueuedMessageState[]>();
    private queueSourceSubscriptions = new Map<string, Map<RuntimeAgentSession, QueueSourceSubscription>>();
    private transitionEventUnsubscribers = new Map<string, () => void>();
    private steeringDeliveryTails = new Map<string, Promise<void>>();
    private nextSteeringSubmissionOrder = 0;
    private queuedMessageDrainTasks = new Map<string, Promise<void>>();

    cleanupSession(sessionId: string) {
        this.removeAllQueueSourceSubscriptions(sessionId);
        this.transitionEventUnsubscribers.get(sessionId)?.();
        this.transitionEventUnsubscribers.delete(sessionId);
        this.queuedMessages.delete(sessionId);
        this.steeringDeliveryTails.delete(sessionId);
        this.queuedMessageDrainTasks.delete(sessionId);
    }

    getQueuedMessages(sessionId: string) {
        return (this.queuedMessages.get(sessionId) || []).map(toRuntimeQueuedMessage);
    }

    getActiveSteeringTarget(hostedSession: import(".././hosted-session.js").HostedSession) {
        const candidate = hostedSession.getActiveSteeringTargetSession?.();
        return isRuntimeAgentSession(candidate) ? candidate : null;
    }

    scheduleQueuedMessageDrain(sessionId: string) {
        if (this.queuedMessageDrainTasks.has(sessionId)) return;
        const task = this.drainQueuedMessages(sessionId).finally(() => {
            if (this.queuedMessageDrainTasks.get(sessionId) === task) {
                this.queuedMessageDrainTasks.delete(sessionId);
            }
        });
        this.queuedMessageDrainTasks.set(sessionId, task);
    }

    async drainQueuedMessages(sessionId: string) {
        while (this.services.sessionHost.getSession(sessionId)) {
            const hostedSession = this.services.sessionHost.getSession(sessionId);
            const managed = hostedSession?.getManagedMetadata?.() || null;
            if (!hostedSession || !managed || !this.services.sessionStore) return;
            const queued = (this.queuedMessages.get(sessionId) || []).filter(
                (message) => message.delivery === "next_turn",
            );
            if (queued.length === 0) return;
            const state = this.services.sessionStore.inspectSessionActivation(managed.runwieldSessionId);
            if (state.activation?.state !== "idle" || this.managedOperations.hasOperation(sessionId)) {
                await new Promise((resolve) => setTimeout(resolve, 300));
                continue;
            }
            await this.sync.synchronizeManagedSession(sessionId, { emitEvents: false });
            const claimed = this.takeNextTurnMessage(sessionId).message;
            if (!claimed) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                continue;
            }
            try {
                await this.turns.promptUserTurn(sessionId, {
                    inputSurface: hostedSession.notificationSurface || claimed.inputSurface,
                    initialRequest: claimed.text,
                    initialImages: claimed.images,
                });
            } catch {
                this.queueNextTurnMessage(sessionId, claimed.text, claimed.images, {
                    deliverWhenAvailable: true,
                    inputSurface: claimed.inputSurface,
                });
                await new Promise((resolve) => setTimeout(resolve, 300));
            }
        }
    }

    ensureQueueSourceSubscription(
        hostedSession: import(".././hosted-session.js").HostedSession,
        sourceSession: RuntimeAgentSession,
    ) {
        let subscriptions = this.queueSourceSubscriptions.get(hostedSession.id);
        if (!subscriptions) {
            subscriptions = new Map();
            this.queueSourceSubscriptions.set(hostedSession.id, subscriptions);
        }
        if (subscriptions.has(sourceSession)) return;
        const unsubscribe = sourceSession.subscribe((event) => {
            if (event.type !== "queue_update") return;
            this.reconcileQueuedMessages(hostedSession, sourceSession, event.steering);
        });
        subscriptions.set(sourceSession, { sourceSession, unsubscribe });
    }

    reconcileQueuedMessages(
        hostedSession: import(".././hosted-session.js").HostedSession,
        sourceSession: RuntimeAgentSession,
        steering: readonly string[] | undefined,
    ) {
        const sourceMessages = (this.queuedMessages.get(hostedSession.id) || []).filter(
            (message) => message.sourceSession === sourceSession,
        );
        const consumedCount = Math.max(0, sourceMessages.length - (steering?.length || 0));
        for (const message of sourceMessages.slice(0, consumedCount)) {
            if (
                hostedSession.isAgentTransitioning?.() &&
                hostedSession.queueAgentTransitionSteering(
                    message.text,
                    message.images,
                    toRuntimeQueuedMessage(message),
                    message.submissionOrder,
                )
            ) {
                delete message.sourceSession;
                continue;
            }
            this.transitionQueuedMessage(hostedSession, message, "consumed");
        }
        const sourceStillQueued = (this.queuedMessages.get(hostedSession.id) || []).some(
            (message) => message.sourceSession === sourceSession,
        );
        if (!sourceStillQueued) this.removeQueueSourceSubscription(hostedSession.id, sourceSession);
    }

    reconcileQueuedMessageSources(hostedSession: import(".././hosted-session.js").HostedSession) {
        const subscriptions = this.queueSourceSubscriptions.get(hostedSession.id);
        if (!subscriptions) return;
        for (const { sourceSession } of [...subscriptions.values()]) {
            const activeSteering = sourceSession.getSteeringMessages?.();
            if (Array.isArray(activeSteering)) {
                this.reconcileQueuedMessages(hostedSession, sourceSession, activeSteering);
            }
        }
    }

    removeQueueSourceSubscription(sessionId: string, sourceSession: RuntimeAgentSession) {
        const subscriptions = this.queueSourceSubscriptions.get(sessionId);
        if (!subscriptions) return;
        const subscription = subscriptions.get(sourceSession);
        if (!subscription) return;
        subscription.unsubscribe();
        subscriptions.delete(sourceSession);
        if (subscriptions.size === 0) this.queueSourceSubscriptions.delete(sessionId);
    }

    removeAllQueueSourceSubscriptions(sessionId: string) {
        const subscriptions = this.queueSourceSubscriptions.get(sessionId);
        if (!subscriptions) return;
        for (const subscription of subscriptions.values()) subscription.unsubscribe();
        this.queueSourceSubscriptions.delete(sessionId);
    }

    ensureTransitionEventSubscription(hostedSession: import(".././hosted-session.js").HostedSession) {
        if (this.transitionEventUnsubscribers.has(hostedSession.id)) return;
        const unsubscribe = hostedSession.subscribeRuntimeEvents((event) => {
            const transition = event as {
                type?: string;
                status?: "consumed" | "dequeued";
                message?: { id?: string };
            };
            if (
                transition.type !== RuntimeEventTypes.QUEUED_MESSAGE_CHANGED ||
                (transition.status !== "consumed" && transition.status !== "dequeued") ||
                !transition.message?.id
            )
                return;
            const queue = this.queuedMessages.get(hostedSession.id);
            const message = queue?.find((entry) => entry.id === transition.message?.id);
            if (!queue || !message || message.sourceSession) return;
            queue.splice(queue.indexOf(message), 1);
            if (queue.length === 0) this.queuedMessages.delete(hostedSession.id);
        });
        this.transitionEventUnsubscribers.set(hostedSession.id, unsubscribe);
    }

    transitionQueuedMessage(
        hostedSession: import(".././hosted-session.js").HostedSession,
        message: RuntimeQueuedMessageState,
        status: "consumed" | "dequeued",
        reason: string = "",
    ) {
        const queue = this.queuedMessages.get(hostedSession.id);
        const index = queue?.indexOf(message) ?? -1;
        if (!queue || index < 0) return null;
        queue.splice(index, 1);
        if (queue.length === 0) this.queuedMessages.delete(hostedSession.id);
        const publicMessage = toRuntimeQueuedMessage(message);
        hostedSession.completeAgentSteeringPreparation?.(message.id);
        this.events.emitSessionEvent(hostedSession.id, {
            type: RuntimeEventTypes.QUEUED_MESSAGE_CHANGED,
            status,
            message: publicMessage,
            ...(reason ? { reason } : {}),
        });
        if (status === "consumed" && message.delivery === "steer") {
            this.events.emitSessionEvent(hostedSession.id, {
                type: RuntimeEventTypes.USER_MESSAGE,
                messageId: message.id,
                text: message.text,
                images: message.images.map((image) => ({ ...image })),
            });
        }
        return publicMessage;
    }

    async steerSession(
        sessionId: string,
        text: string,
        images: import(".././types.js").ImageAttachment[] = [],
        inputSurface: import("../session-runtime-events.js").NotificationSurface = this.services.ownerProcessKind,
    ): Promise<import("./types.ts").SteerSessionResult> {
        const hostedSession = this.services.sessionHost.getSession(sessionId);
        if (!hostedSession) return { ok: false, queued: false, error: "not_found" };
        const capability =
            this.managedOperations.currentCapability(sessionId) ||
            hostedSession.getManagedOperationCapability?.() ||
            null;
        const managedRejection = this.managedOperations.rejectManagedPublicMutation(
            hostedSession,
            "steerSession",
            capability,
        );
        if (managedRejection) return { ...managedRejection, queued: false };

        const message: RuntimeQueuedMessageState = {
            id: crypto.randomUUID(),
            text,
            images: images.map((image) => ({ ...image })),
            inputSurface,
            delivery: "steer",
            queuedAt: new Date().toISOString(),
            submissionOrder: this.nextSteeringSubmissionOrder++,
            preparing: true,
        };
        const publicMessage = this.trackQueuedMessage(hostedSession, message);
        hostedSession.beginAgentSteeringPreparation(message.id);

        const previousDelivery = this.steeringDeliveryTails.get(sessionId) || Promise.resolve();
        let releaseDelivery: () => void = () => {};
        const deliveryDone = new Promise<void>((resolve) => {
            releaseDelivery = resolve;
        });
        const deliveryTail = previousDelivery.catch(() => undefined).then(() => deliveryDone);
        this.steeringDeliveryTails.set(sessionId, deliveryTail);

        try {
            await previousDelivery.catch(() => undefined);
            if (!(this.queuedMessages.get(sessionId) || []).includes(message)) {
                return { ok: true, queued: false, reason: "dequeued" };
            }

            let activeTarget = this.getActiveSteeringTarget(hostedSession);
            let rootSession = getRuntimeRootAgentSession(hostedSession);
            let expectedTarget = activeTarget?.isStreaming ? activeTarget : rootSession;
            if (!hostedSession.isAgentTransitioning?.() && !expectedTarget?.isStreaming) {
                this.transitionQueuedMessage(hostedSession, message, "dequeued", "not_streaming");
                return { ok: true, queued: false, reason: "not_streaming" };
            }

            while (true) {
                if (hostedSession.queueAgentTransitionSteering(text, images, publicMessage, message.submissionOrder)) {
                    delete message.preparing;
                    hostedSession.notificationSurface = inputSurface;
                    return { ok: true, queued: true, message: publicMessage };
                }
                activeTarget = this.getActiveSteeringTarget(hostedSession);
                rootSession = getRuntimeRootAgentSession(hostedSession);
                expectedTarget = activeTarget?.isStreaming ? activeTarget : rootSession;
                if (!expectedTarget?.isStreaming) {
                    this.transitionQueuedMessage(hostedSession, message, "dequeued", "not_streaming");
                    return { ok: true, queued: false, reason: "not_streaming" };
                }

                const preparedInput = await this.images.prepareSteeringInputForAgentSession(
                    hostedSession,
                    text,
                    images,
                    expectedTarget,
                );
                if (!preparedInput.ok) throw new Error(preparedInput.message);
                if (!(this.queuedMessages.get(sessionId) || []).includes(message)) {
                    return { ok: true, queued: false, reason: "dequeued" };
                }
                if (hostedSession.isAgentTransitioning?.()) continue;

                activeTarget = this.getActiveSteeringTarget(hostedSession);
                rootSession = getRuntimeRootAgentSession(hostedSession);
                const currentTarget = activeTarget?.isStreaming ? activeTarget : rootSession;
                if (currentTarget !== expectedTarget) continue;

                message.sourceSession = expectedTarget;
                delete message.preparing;
                this.ensureQueueSourceSubscription(hostedSession, expectedTarget);
                const sourceSession = await steerAgentSessionWithPreparedInput(
                    expectedTarget,
                    preparedInput.text,
                    preparedInput.images,
                );
                if (!sourceSession) {
                    this.transitionQueuedMessage(hostedSession, message, "dequeued", "not_streaming");
                    this.removeQueueSourceSubscription(hostedSession.id, expectedTarget);
                    return { ok: true, queued: false, reason: "not_streaming" };
                }
                const activeSteering = sourceSession.getSteeringMessages?.();
                if (Array.isArray(activeSteering)) {
                    this.reconcileQueuedMessages(hostedSession, sourceSession, activeSteering);
                }
                hostedSession.notificationSurface = inputSurface;
                return { ok: true, queued: true, message: publicMessage };
            }
        } catch (error) {
            if ((this.queuedMessages.get(sessionId) || []).includes(message)) {
                this.transitionQueuedMessage(hostedSession, message, "dequeued", "delivery_failed");
            }
            throw error;
        } finally {
            hostedSession.completeAgentSteeringPreparation(message.id);
            releaseDelivery();
            if (this.steeringDeliveryTails.get(sessionId) === deliveryTail) {
                this.steeringDeliveryTails.delete(sessionId);
            }
        }
    }

    queueNextTurnMessage(
        sessionId: string,
        text: string,
        images: import(".././types.js").ImageAttachment[] = [],
        options: {
            deliverWhenAvailable?: boolean;
            inputSurface?: import("../session-runtime-events.js").NotificationSurface;
        } = {},
    ): import("./types.ts").SteerSessionResult {
        const hostedSession = this.services.sessionHost.getSession(sessionId);
        if (!hostedSession) return { ok: false, queued: false, error: "not_found" };
        const message: RuntimeQueuedMessageState = {
            id: crypto.randomUUID(),
            text,
            images: images.map((image) => ({ ...image })),
            inputSurface: options.inputSurface || this.services.ownerProcessKind,
            delivery: "next_turn",
            queuedAt: new Date().toISOString(),
        };
        const publicMessage = this.trackQueuedMessage(hostedSession, message);
        hostedSession.notificationSurface = message.inputSurface || this.services.ownerProcessKind;
        if (options.deliverWhenAvailable) this.scheduleQueuedMessageDrain(sessionId);
        return { ok: true, queued: true, message: publicMessage };
    }

    takeNextTurnMessage(sessionId: string) {
        const hostedSession = this.services.sessionHost.getSession(sessionId);
        if (!hostedSession) return { ok: false, message: null, error: "not_found" };
        const selected = (this.queuedMessages.get(hostedSession.id) || []).find(
            (message) => message.delivery === "next_turn",
        );
        if (!selected) return { ok: true, message: null };
        const publicMessage = this.transitionQueuedMessage(hostedSession, selected, "consumed");
        return { ok: true, message: publicMessage };
    }

    trackQueuedMessage(
        hostedSession: import(".././hosted-session.js").HostedSession,
        message: RuntimeQueuedMessageState,
    ) {
        this.ensureTransitionEventSubscription(hostedSession);
        let queue = this.queuedMessages.get(hostedSession.id);
        if (!queue) {
            queue = [];
            this.queuedMessages.set(hostedSession.id, queue);
        }
        queue.push(message);
        const publicMessage = toRuntimeQueuedMessage(message);
        this.events.emitSessionEvent(hostedSession.id, {
            type: RuntimeEventTypes.QUEUED_MESSAGE_CHANGED,
            status: "queued",
            message: publicMessage,
        });
        return publicMessage;
    }

    /** Remove only undelivered background steering; keep user input and its images in order. */
    async removeBackgroundSteering(
        hostedSession: import(".././hosted-session.js").HostedSession,
        sourceSession: RuntimeAgentSession,
        queueIndex: number,
    ): Promise<void> {
        if (sourceSession.removeSteeringMessage) {
            await sourceSession.removeSteeringMessage(queueIndex);
            return;
        }
        if (typeof sourceSession.clearQueue !== "function" || !sourceSession.getSteeringMessages) {
            throw new Error("Background steering queue is not mutable");
        }
        const snapshot = [...sourceSession.getSteeringMessages()];
        const queued = (this.queuedMessages.get(hostedSession.id) || []).filter(
            (message) => message.sourceSession === sourceSession,
        );
        this.removeQueueSourceSubscription(hostedSession.id, sourceSession);
        const cleared = sourceSession.clearQueue();
        try {
            for (const [position, entry] of (cleared?.steering ?? snapshot).entries()) {
                if (position === queueIndex) continue;
                const index = queued.findIndex((message) => message.text === entry);
                const tracked = index < 0 ? null : queued.splice(index, 1)[0];
                const restored = await steerAgentSessionWithTarget(sourceSession, entry, tracked?.images);
                if (!restored) {
                    // A stopped stream cannot accept steering; retain user input for the next turn.
                    if (tracked) this.transitionQueuedMessage(hostedSession, tracked, "dequeued", "background_cleanup");
                    this.queueNextTurnMessage(hostedSession.id, entry, tracked?.images || [], {
                        inputSurface: tracked?.inputSurface,
                    });
                }
            }
            for (const entry of cleared?.followUp || []) {
                const index = queued.findIndex((message) => message.text === entry);
                const tracked = index < 0 ? null : queued.splice(index, 1)[0];
                if (sourceSession.isStreaming) {
                    const prepared = await this.images.prepareSteeringInputForAgentSession(
                        hostedSession,
                        entry,
                        tracked?.images || [],
                        sourceSession,
                    );
                    if (!prepared.ok) throw new Error(prepared.message);
                    await (sourceSession as import("@earendil-works/pi-coding-agent").AgentSession).followUp(
                        prepared.text,
                        prepared.images,
                    );
                } else {
                    if (tracked) this.transitionQueuedMessage(hostedSession, tracked, "dequeued", "background_cleanup");
                    this.queueNextTurnMessage(hostedSession.id, entry, tracked?.images || [], {
                        inputSurface: tracked?.inputSurface,
                    });
                }
            }
        } finally {
            if (
                queued.length ||
                (this.queuedMessages.get(hostedSession.id) || []).some(
                    (message) => message.sourceSession === sourceSession,
                )
            )
                this.ensureQueueSourceSubscription(hostedSession, sourceSession);
        }
    }

    async dequeueLastQueuedMessage(sessionId: string) {
        const hostedSession = this.services.sessionHost.getSession(sessionId);
        if (!hostedSession) return { ok: false, message: null, error: "not_found" };
        const queue = this.queuedMessages.get(hostedSession.id) || [];
        const selected = queue.at(-1) || null;
        if (!selected) return { ok: true, message: null };

        if (selected.delivery === "next_turn") {
            const publicMessage = this.transitionQueuedMessage(hostedSession, selected, "dequeued", "user_recall");
            return { ok: true, message: publicMessage };
        }
        if (selected.preparing) {
            const publicMessage = this.transitionQueuedMessage(hostedSession, selected, "dequeued", "user_recall");
            return { ok: true, message: publicMessage };
        }

        const capability = this.managedOperations.currentCapability(sessionId) || null;
        const managedRejection = this.managedOperations.rejectManagedPublicMutation(
            hostedSession,
            "dequeueLastQueuedMessage",
            capability,
        );
        if (managedRejection) return { ...managedRejection, message: null };

        const sourceSession = selected.sourceSession;
        if (!sourceSession) {
            if (!hostedSession.removeAgentTransitionSteering?.(selected.id)) {
                return { ok: false, message: null, error: "queue_not_mutable" };
            }
            const publicMessage = this.transitionQueuedMessage(hostedSession, selected, "dequeued", "user_recall");
            return { ok: true, message: publicMessage };
        }
        const sourceMessages = queue.filter((message) => message.sourceSession === sourceSession);
        if (sourceSession.removeSteeringMessage) {
            this.removeQueueSourceSubscription(hostedSession.id, sourceSession);
            try {
                const removed = await sourceSession.removeSteeringMessage(sourceMessages.indexOf(selected));
                const message = removed
                    ? this.transitionQueuedMessage(hostedSession, selected, "dequeued", "user_recall")
                    : null;
                return { ok: true, message };
            } catch (error) {
                return { ok: false, message: null, error: getRuntimeErrorMessage(error) };
            } finally {
                this.ensureQueueSourceSubscription(hostedSession, sourceSession);
                this.reconcileQueuedMessages(hostedSession, sourceSession, sourceSession.getSteeringMessages?.());
            }
        }
        if (typeof sourceSession.clearQueue !== "function") {
            return { ok: false, message: null, error: "queue_not_mutable" };
        }
        this.removeQueueSourceSubscription(hostedSession.id, sourceSession);
        let cleared;
        try {
            cleared = sourceSession.clearQueue();
        } catch (error) {
            this.ensureQueueSourceSubscription(hostedSession, sourceSession);
            return {
                ok: false,
                message: null,
                error: getRuntimeErrorMessage(error),
            };
        }

        let requeueError = "";
        try {
            for (const message of sourceMessages) {
                if (message.id === selected.id) continue;
                const requeued = await steerAgentSessionWithTarget(sourceSession, message.text, message.images);
                if (requeued !== sourceSession) {
                    throw new Error("source session stopped streaming while restoring its queue");
                }
            }
            const followUps = cleared && typeof cleared === "object" ? cleared.followUp || [] : [];
            for (const followUp of followUps) await sourceSession.followUp?.(followUp);
        } catch (error) {
            requeueError = getRuntimeErrorMessage(error);
        }

        const publicMessage = toRuntimeQueuedMessage(selected);
        if (requeueError) {
            for (const message of sourceMessages) {
                this.transitionQueuedMessage(
                    hostedSession,
                    message,
                    "dequeued",
                    message.id === selected.id ? "user_recall" : "requeue_failed",
                );
            }
            return { ok: true, message: publicMessage, warning: requeueError };
        }

        this.transitionQueuedMessage(hostedSession, selected, "dequeued", "user_recall");
        const sourceStillQueued = (this.queuedMessages.get(hostedSession.id) || []).some(
            (message) => message.sourceSession === sourceSession,
        );
        if (sourceStillQueued) this.ensureQueueSourceSubscription(hostedSession, sourceSession);
        return { ok: true, message: publicMessage };
    }

    async clearQueuedMessages(sessionId: string, reason: string = "cleared") {
        const hostedSession = this.services.sessionHost.getSession(sessionId);
        if (!hostedSession) return { ok: false, cleared: 0, error: "not_found" };
        const managed = hostedSession.getManagedMetadata?.();
        if (managed && !hostedSession.getRootSessionManager?.()) {
            return await this.managedOperations.runManagedStandaloneMutation(
                sessionId,
                "submit_user_turn",
                (activeSession) => this.clearQueuedMessagesInternal(activeSession, reason),
                { activateAgent: false },
            );
        }
        const managedRejection = this.managedOperations.rejectManagedPublicMutation(
            hostedSession,
            "clearQueuedMessages",
        );
        if (managedRejection) return { ...managedRejection, cleared: 0 };
        return this.clearQueuedMessagesInternal(hostedSession, reason);
    }

    clearQueuedMessagesInternal(hostedSession: import(".././hosted-session.js").HostedSession, reason: string) {
        const messages = [...(this.queuedMessages.get(hostedSession.id) || [])];
        const sources = new Set(messages.map((message) => message.sourceSession).filter(Boolean));
        const clearedSources = new Set();
        for (const sourceSession of sources) {
            if (!sourceSession || typeof sourceSession.clearQueue !== "function") continue;
            this.removeQueueSourceSubscription(hostedSession.id, sourceSession);
            try {
                sourceSession.clearQueue();
                clearedSources.add(sourceSession);
            } catch {
                this.ensureQueueSourceSubscription(hostedSession, sourceSession);
            }
        }
        const transitionEntries = hostedSession.clearAgentTransitionSteering?.() || [];
        const transitionMessageIds = new Set(transitionEntries.map((entry) => entry.message?.id).filter(Boolean));
        const clearedMessages = messages.filter(
            (message) =>
                message.delivery === "next_turn" ||
                message.preparing ||
                transitionMessageIds.has(message.id) ||
                (message.sourceSession && clearedSources.has(message.sourceSession)),
        );
        for (const message of clearedMessages) {
            this.transitionQueuedMessage(hostedSession, message, "dequeued", reason);
        }
        return { ok: true, cleared: clearedMessages.length };
    }
}
