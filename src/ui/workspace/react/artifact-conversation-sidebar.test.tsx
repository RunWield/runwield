import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { act } from "react";
import { ArtifactConversationSidebar } from "./ArtifactConversationSidebar.tsx";

Deno.test("review chat enables annotation-only send by click and keyboard, and disables on detach or while busy", async () => {
    const browser = new Window({ url: "http://workspace.local" });
    const globals = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"];
    const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const container = browser.document.createElement("div");
    browser.document.body.append(container);
    let sends = 0;
    try {
        Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
        Object.defineProperty(globalThis, "document", { configurable: true, value: browser.document });
        Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
        const { createRoot } = await import("react-dom/client");
        const root = createRoot(container);
        try {
            for (const agentLabel of ["Planner", "Engineer"]) {
                const props = {
                    agentLabel,
                    messages: [],
                    composer: "  ",
                    working: false,
                    onComposerChange: () => {},
                    onSend: () => {
                        sends++;
                    },
                };
                const sendButton = () => container.querySelector<HTMLButtonElement>(".rw-review-action-button")!;
                await act(() => root.render(<ArtifactConversationSidebar {...props} />));
                assertEquals(sendButton().disabled, true);
                await act(() =>
                    root.render(
                        <ArtifactConversationSidebar {...props} attachedContextLabel="1 review note attached" />,
                    )
                );
                assertEquals(sendButton().disabled, false);
                const before = sends;
                await act(() => sendButton().click());
                const textarea = container.querySelector("textarea")!;
                await act(() =>
                    textarea.dispatchEvent(
                        new browser.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
                    )
                );
                assertEquals(sends, before + 2);
                for (const blocking of [{ working: true }, { disabled: true }]) {
                    await act(() =>
                        root.render(
                            <ArtifactConversationSidebar
                                {...props}
                                attachedContextLabel="1 review note attached"
                                {...blocking}
                            />,
                        )
                    );
                    assertEquals(sendButton().disabled, true);
                }
                await act(() => root.render(<ArtifactConversationSidebar {...props} />));
                assertEquals(sendButton().disabled, true);
                await act(() => root.render(<ArtifactConversationSidebar {...props} composer="Explain this change" />));
                assertEquals(sendButton().disabled, false);
            }
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
});
