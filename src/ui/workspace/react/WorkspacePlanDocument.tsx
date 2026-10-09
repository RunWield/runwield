// @ts-nocheck: Workspace is the scoped TSX exception zone and Plannotator is consumed as browser-only UI.
import { RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";

import { lazy, Suspense } from "react";
import { RenderedMarkdown } from "@plannotator/ui/components/RenderedMarkdown.tsx";
import "./plannotator.css";

const WorkspaceMarkdownEditor = lazy(() => import("./WorkspaceMarkdownEditor.tsx"));

export default function WorkspacePlanDocument({
    mode,
    markdown,
    documentId,
    editorHandleRef,
    onMarkdownChange,
}) {
    if (mode === "edit") {
        return (
            <Suspense
                fallback={
                    <p className="notice muted">
                        <RunWieldThinkingDots label="Loading markdown editor" />
                    </p>
                }
            >
                <WorkspaceMarkdownEditor
                    markdown={markdown || ""}
                    documentId={documentId}
                    editorHandleRef={editorHandleRef}
                    onMarkdownChange={onMarkdownChange}
                />
            </Suspense>
        );
    }

    if (!markdown) return <p className="empty">No Plan body content.</p>;
    return (
        <RenderedMarkdown
            markdown={markdown}
            className="markdown-view plannotator-plan-body rw-workspace-rendered-markdown"
        />
    );
}
