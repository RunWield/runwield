import { test } from "node:test";
import { ok as assert } from "node:assert/strict";
import { act, useState } from "react";
import { Window } from "happy-dom";
import { assertEquals, assertStringIncludes } from "../../../testing/assertions.ts";
import { ArtifactConversationSidebar } from "./ArtifactConversationSidebar.tsx";
import { useReviewRevision } from "./use-review-revision.ts";
import {
    mergeSavedReviewMessages,
    useSavedReviewConversation,
    type SavedReviewMessage,
    type SavedReviewSnapshot,
} from "./use-saved-review-conversation.ts";

const payload = {
    token: "restored-page",
    savedConversation: true,
    conversationStatusUrl: "/conversation",
    reviewRevisionUrl: "/revision",
    reviewRevision: 0,
};

function RestoredReview() {
    const [messages, setMessages] = useState<SavedReviewMessage[]>([]);
    const [working, setWorking] = useState(false);
    const [artifact, setArtifact] = useState("Plan N");
    const [error, setError] = useState("");
    const revision = useReviewRevision(payload, false, setError);
    useSavedReviewConversation(
        payload,
        (snapshot, advanced) => {
            revision.update(snapshot.reviewRevision);
            setMessages((items) => mergeSavedReviewMessages(items, snapshot));
            setWorking(snapshot.pending);
            if (advanced) setArtifact(snapshot.plan);
        },
        setError,
    );
    return (
        <>
            <article>{artifact}</article>
            <p role="alert">{error}</p>
            <ArtifactConversationSidebar
                agentLabel="Claude"
                messages={messages}
                composer=""
                working={working}
                onComposerChange={() => {}}
                onSend={() => {}}
            />
            {["Approve", "Feedback", "Chat"].map((action) => (
                <button
                    type="button"
                    key={action}
                    disabled={working}
                    onClick={() =>
                        void fetch("/decision", {
                            method: "POST",
                            body: JSON.stringify({ action, ...revision.fields }),
                        })
                    }
                >
                    {action}
                </button>
            ))}
        </>
    );
}

interface Decision {
    action: string;
    reviewRevision: number;
}
interface ReviewBrowser {
    container: HTMLDivElement;
    decisions: Decision[];
    snapshot: (value: SavedReviewSnapshot) => void;
    poll: () => Promise<void>;
    reload: () => Promise<void>;
}

async function withSavedReview(verify: (browser: ReviewBrowser) => Promise<void>) {
    const browser = new Window({ url: "http://review.local/new-host-url" });
    const globals = ["window", "document", "fetch", "IS_REACT_ACT_ENVIRONMENT"];
    const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const container = browser.document.createElement("div");
    browser.document.body.append(container);
    let current: SavedReviewSnapshot = {
        turns: [{ turnId: "queued", message: "Saved user question" }],
        events: [],
        pending: true,
        revision: 0,
        reviewRevision: 0,
        plan: "Plan N",
        rawPatch: "",
    };
    const decisions: Decision[] = [];
    try {
        Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
        Object.defineProperty(globalThis, "document", { configurable: true, value: browser.document });
        Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
        globalThis.fetch = (url, options) => {
            if (String(url) === "/decision") {
                decisions.push(JSON.parse(String(options?.body)));
                return Promise.resolve(Response.json({ ok: true }));
            }
            assertEquals(String(url), "/conversation");
            return Promise.resolve(Response.json(current));
        };
        const { createRoot } = await import("react-dom/client");
        let root = createRoot(container);
        await act(() => root.render(<RestoredReview />));
        try {
            await verify({
                container: container as HTMLDivElement,
                decisions,
                snapshot: (value) => {
                    current = value;
                },
                poll: () =>
                    act(async () => {
                        await new Promise((resolve) => setTimeout(resolve, 800));
                    }),
                reload: async () => {
                    await act(() => root.unmount());
                    root = createRoot(container);
                    await act(() => root.render(<RestoredReview />));
                },
            });
        } finally {
            await act(() => root.unmount());
        }
    } finally {
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await browser.happyDOM.close();
    }
}

function answeredSnapshot(reviewRevision = 0): SavedReviewSnapshot {
    return {
        turns: [{ turnId: "queued", message: "Saved user question", reply: "Saved Claude answer" }],
        events: [{ messageId: "queued", delta: "Saved Claude answer" }],
        pending: false,
        revision: 1,
        reviewRevision,
        plan: "Plan N+1",
        rawPatch: "",
    };
}

test("a new review page restores a queued user turn, polls its answer, and restores both after reload", async () => {
    await withSavedReview(async ({ container, snapshot, poll, reload }) => {
        assertStringIncludes(container.textContent || "", "Saved user question");
        const approve = () =>
            [...container.querySelectorAll("button")].find((button) => button.textContent === "Approve")!;
        assertEquals(approve().disabled, true);
        snapshot(answeredSnapshot());
        await poll();
        assertStringIncludes(container.textContent || "", "Saved Claude answer");
        assertEquals(approve().disabled, false);
        await reload();
        assertStringIncludes(container.textContent || "", "Saved user question");
        assertStringIncludes(container.textContent || "", "Saved Claude answer");
        assertEquals(container.textContent?.split("Saved Claude answer").length, 2);
    });
});

test("the displayed N+1 artifact binds approval, Feedback, and further chat to its decision revision", async () => {
    await withSavedReview(async ({ container, snapshot, poll, decisions }) => {
        snapshot(answeredSnapshot(1));
        await poll();
        assertEquals(container.querySelector("article")?.textContent, "Plan N+1");
        for (const action of ["Approve", "Feedback", "Chat"]) {
            const button = [...container.querySelectorAll("button")].find((item) => item.textContent === action);
            assert(button && !button.disabled);
            await act(() => button.click());
        }
        assertEquals(
            decisions,
            ["Approve", "Feedback", "Chat"].map((action) => ({ action, reviewRevision: 1 })),
        );
    });
});
