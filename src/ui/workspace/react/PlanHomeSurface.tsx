// @ts-nocheck: Workspace React islands compile TSX, but this module uses JSDoc-style JavaScript only.
import { PlanBodyEditor } from "../islands/PlanBodyEditor.jsx";
import { submitWorkflowAction } from "../browser/workflow-action.ts";

import { useEffect, useMemo, useState } from "react";
import { ArtifactReadSurface } from "./ArtifactReadSurface.tsx";
import { WorkflowSidebar } from "./WorkflowSidebar.tsx";
import { buildWorkflowPresentation } from "../../../shared/workflow/workflow-presentation.ts";

function ownerCookie(name) {
    return (
        document.cookie
            .split("; ")
            .find((value) => value.startsWith(`${name}=`))
            ?.split("=")
            .slice(1)
            .join("=") || ""
    );
}

async function ownerFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    headers.set("x-runwield-csrf", decodeURIComponent(ownerCookie("rw_owner_csrf")));
    const response = await fetch(url, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(payload.error || `Request failed with ${response.status}`);
    return payload;
}

function progressFacts(progress) {
    return Array.isArray(progress?.progressFacts) ? progress.progressFacts : [];
}

function valueFromProgress(payload, progress, field) {
    return progress && Object.hasOwn(progress, field) ? progress[field] : payload[field];
}

function buildPresentation(payload, progress) {
    return buildWorkflowPresentation({
        planName: payload.title || payload.planName || payload.planId,
        epicName: payload.epicName || payload.parentPlan,
        intent: payload.classification,
        classification: payload.classification,
        projectPlanType: payload.type || payload.attrs?.type,
        status: progress?.overall?.state === "completed" ? "verified" : progress?.plan?.status || payload.status,
        validationPhase: progress?.plan?.validationPhase || payload.attrs?.validationPhase,
        progressFacts: progressFacts(progress || payload.workflow),
        degradedMessage:
            typeof progress?.degraded?.message === "string"
                ? progress.degraded.message
                : typeof payload.workflow?.degradedMessage === "string"
                  ? payload.workflow.degradedMessage
                  : "",
        sessionState:
            typeof progress?.session?.state === "string"
                ? progress.session.state
                : typeof payload.workflow?.sessionState === "string"
                  ? payload.workflow.sessionState
                  : "",
        hasWorkingSession: Boolean(
            valueFromProgress(payload, progress, "sessionHref") || progress?.session?.runwieldSessionId,
        ),
        hasLiveQuestion: Boolean(valueFromProgress(payload, progress, "interactionHref")),
        hasPlanReview: valueFromProgress(payload, progress, "reviewKind") === "plan",
        hasCodeReview: valueFromProgress(payload, progress, "reviewKind") === "code",
        canRun: valueFromProgress(payload, progress, "canRun") === true,
        canResume: valueFromProgress(payload, progress, "canResume") === true,
        canRecover: Boolean(valueFromProgress(payload, progress, "canRecover")),
    });
}

export function PlanHomeSurface({ payload, presentation = "standalone" }) {
    const [document, setDocument] = useState(payload.packageDocument || null);
    const [documentError, setDocumentError] = useState("");
    const [documentLoading, setDocumentLoading] = useState(false);
    async function selectDocument(name) {
        setDocumentLoading(true);
        setDocumentError("");
        try {
            setDocument(await ownerFetch(`${payload.documentUrl}/${encodeURIComponent(name)}`));
        } catch (error) {
            setDocumentError(error.message);
        } finally {
            setDocumentLoading(false);
        }
    }
    const [progress, setProgress] = useState(payload.workflow || null);
    useEffect(() => {
        if (!payload.progressApiUrl) return;
        let cancelled = false;
        let inFlight = false;
        async function refresh() {
            if (inFlight) return;
            inFlight = true;
            try {
                const next = await ownerFetch(payload.progressApiUrl, { method: "GET" });
                if (!cancelled) setProgress(next);
            } catch (error) {
                if (!cancelled) {
                    setProgress((current) => ({ ...current, degraded: { message: error.message || String(error) } }));
                }
            } finally {
                inFlight = false;
            }
        }
        refresh();
        const timer = setInterval(refresh, 5000);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [payload.progressApiUrl]);

    async function runAction(action) {
        const actionPayload = {
            requestId: crypto.randomUUID(),
            expectedGeneration: progress?.expectedGeneration ?? payload.expectedGeneration,
            expectedRevision: progress?.expectedRevision ?? payload.expectedRevision,
            expectedCurrentSegmentId: progress?.expectedCurrentSegmentId ?? payload.expectedCurrentSegmentId,
            planId: payload.planId,
            action: action.kind,
        };
        const workflowUrl = progress?.planWorkflowUrl || payload.planWorkflowUrl;
        if (["run", "resume", "recover", "review_plan", "resume_from_hold"].includes(action.kind) && workflowUrl) {
            const result = await submitWorkflowAction(workflowUrl, actionPayload);
            if (result.canceled) return "Plan remains on hold.";
            if (action.kind === "resume_from_hold") {
                setProgress(await ownerFetch(payload.progressApiUrl, { method: "GET" }));
                return result.result?.message || "Plan resumed from hold.";
            }
            if (result.reviewUrl) {
                location.assign(result.reviewUrl);
                return;
            }
        }
        if (progress?.sessionHref || payload.sessionHref) {
            location.assign(progress?.sessionHref || payload.sessionHref);
        }
    }

    const artifactPayload = useMemo(
        () => ({
            markdown: document?.body || payload.markdown || payload.body || "",
            mode: payload.mode || "dev",
            artifactKind: "plan",
            title: payload.title || payload.planName || "Plan",
            artifactPath: payload.artifactPath,
            returnHref: payload.returnHref || "/",
            returnLabel: payload.returnLabel || "Back",
            imageBaseDir: payload.imageBaseDir,
            notices: [
                ...new Set(
                    [
                        ...(payload.notices || []),
                        ...(payload.readAvailability?.kind === "pending" ? [payload.readAvailability.message] : []),
                        progress?.degraded?.message || payload.workflow?.degradedMessage,
                    ].filter(Boolean),
                ),
            ],
        }),
        [payload, progress, document],
    );
    const workflow = useMemo(() => buildPresentation(payload, progress), [payload, progress]);

    return (
        <ArtifactReadSurface
            payload={artifactPayload}
            embedded={presentation === "workspace"}
            showLogo={false}
            contentsInitiallyOpen={false}
            documentContent={
                document && (
                    <section
                        className="rw-plan-documents"
                        aria-label="Plan documents"
                        onClick={(event) => {
                            const anchor = event.target.closest?.("a");
                            const target = anchor?.getAttribute("href");
                            if (document.documents.some((entry) => entry.name === target)) {
                                event.preventDefault();
                                void selectDocument(target);
                            }
                        }}
                    >
                        <div className="rw-plan-document-controls">
                            <label htmlFor="plan-document">Document</label>{" "}
                            <select
                                id="plan-document"
                                value={document.resource}
                                disabled={documentLoading}
                                onChange={(event) => selectDocument(event.target.value)}
                            >
                                {document.documents.map((entry) => (
                                    <option key={entry.name} value={entry.name}>
                                        {entry.role}
                                    </option>
                                ))}
                            </select>{" "}
                            <button
                                type="button"
                                className="rw-button"
                                disabled={documentLoading}
                                onClick={() => selectDocument(document.resource)}
                            >
                                Refresh
                            </button>
                        </div>
                        <p role="status">
                            {documentLoading ? "Loading document…" : `Revision ${document.revision.slice(0, 12)}`}
                        </p>
                        {documentError && <p role="alert">{documentError}</p>}
                        <PlanBodyEditor
                            key={`${document.resource}:${document.revision}`}
                            plan={{
                                planId: `${payload.planId}:${document.resource}`,
                                workspaceKey: payload.documentUrl,
                                body: document.body,
                                bodyHash: document.revision,
                                revision: document.revision,
                                capabilities: { bodyEditing: document.writable },
                                documentUrl: `${payload.documentUrl}/${encodeURIComponent(document.resource)}`,
                                onSaved: setDocument,
                            }}
                        />
                    </section>
                )
            }
            workflowSidebar={
                <WorkflowSidebar
                    presentation={workflow}
                    embedded
                    payload={{ ...payload, ...(progress || {}) }}
                    onAction={runAction}
                />
            }
        />
    );
}
