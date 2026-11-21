// @ts-nocheck: Workspace is the scoped TSX exception zone and Plannotator is consumed as browser-only UI.
import { RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";

import { lazy, Suspense, useEffect } from "react";
import type { LocalLinkResolver } from "@plannotator/ui/components/LocalLinkContext";
import type { MarkdownEditorProps } from "@plannotator/markdown-editor";

export type { MarkdownEditorHandle } from "@plannotator/markdown-editor";
export type WorkspacePlanDocumentMode = "read" | "edit";

export interface WorkspacePlanDocumentProps extends Pick<
    MarkdownEditorProps,
    "markdown" | "documentId" | "editorHandleRef" | "onMarkdownChange"
> {
    mode: WorkspacePlanDocumentMode;
    resolveLocalLink?: LocalLinkResolver;
    fragment?: string;
}
import { RenderedMarkdown } from "@plannotator/ui/components/RenderedMarkdown.tsx";
import "./plannotator.css";

const WorkspaceMarkdownEditor = lazy(() => import("./WorkspaceMarkdownEditor.tsx"));

export default function WorkspacePlanDocument({
    mode,
    markdown,
    documentId,
    editorHandleRef,
    onMarkdownChange,
    resolveLocalLink,
    fragment,
}: WorkspacePlanDocumentProps) {
    useEffect(() => {
        if (mode !== "edit" && fragment) document.getElementById(decodeURIComponent(fragment))?.scrollIntoView();
    }, [mode, markdown, fragment]);
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
            resolveLocalLink={resolveLocalLink}
            headingAnchors
            className="markdown-view plannotator-plan-body rw-workspace-rendered-markdown"
        />
    );
}
