import { RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { RunWieldButton } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { PLAN_UI_TOKEN_HEADER, PLAN_UI_TOKEN_QUERY } from "../constants.ts";
import { MarkdownView } from "../components/MarkdownView.tsx";

/** @type {Record<string, () => Promise<unknown>>} */
let workspacePlanDocumentModules = {};
try {
    workspacePlanDocumentModules = import.meta.glob("../react/WorkspacePlanDocument.tsx");
} catch {
    // Deno test runs do not provide Vite's import.meta.glob transform.
}
const loadWorkspacePlanDocument = /** @type {() => Promise<{ default: import("react").ComponentType<any> }>} */ (
    workspacePlanDocumentModules["../react/WorkspacePlanDocument.tsx"] ||
    (() => Promise.resolve({ default: WorkspacePlanDocumentFallback }))
);
const WorkspacePlanDocument = lazy(loadWorkspacePlanDocument);

/** @param {{ markdown?: string }} props */
function WorkspacePlanDocumentFallback({ markdown = "" }) {
    return <MarkdownView markdown={markdown} />;
}

/**
 * @param {string} workspaceKey
 * @param {string} planId
 */
export function planBodyDraftKey(workspaceKey, planId) {
    return `runwield:workspace:${workspaceKey}:plan:${planId}:bodyDraft`;
}

/**
 * @param {{ baseBodyHash?: string } | null} draft
 * @param {string} currentBodyHash
 * @returns {"none"|"same-base"|"changed-on-disk"}
 */
export function draftRecoveryState(draft, currentBodyHash) {
    if (!draft) return "none";
    return draft.baseBodyHash === currentBodyHash ? "same-base" : "changed-on-disk";
}

/**
 * @param {{ baseBodyHash: string }} draft
 * @returns {string}
 */
export function restoredDraftExpectedBodyHash(draft) {
    return draft.baseBodyHash;
}

/**
 * @typedef {Object} PlanBodyDraft
 * @property {string} body
 * @property {string} baseBodyHash
 * @property {string} [updatedAt]
 */

/** @param {{ body: string, baseBodyHash: string }} draft */
function serializeDraft(draft) {
    return JSON.stringify({ body: draft.body, baseBodyHash: draft.baseBodyHash, updatedAt: new Date().toISOString() });
}

/**
 * @param {string} key
 * @returns {{ body: string, baseBodyHash: string, updatedAt?: string } | null}
 */
function readDraft(key) {
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || "null");
        return parsed && typeof parsed.body === "string" && typeof parsed.baseBodyHash === "string" ? parsed : null;
    } catch {
        return null;
    }
}

/** @param {{ plan: any, initialEdit?: boolean }} props */
export function PlanBodyEditor({ plan, initialEdit = false }) {
    const canEdit = plan.capabilities?.bodyEditing !== false;
    const [clientReady, setClientReady] = useState(false);
    const [mode, setMode] = useState("read");
    const [body, setBody] = useState(plan.body || "");
    const [savedBody, setSavedBody] = useState(plan.body || "");
    const [bodyHash, setBodyHash] = useState(plan.bodyHash || "");
    const [expectedBodyHash, setExpectedBodyHash] = useState(plan.bodyHash || "");
    const [expectedRevision, setExpectedRevision] = useState(plan.revision || "");
    const [message, setMessage] = useState("");
    const [draft, setDraft] = useState(/** @type {PlanBodyDraft | null} */ (null));
    const [saving, setSaving] = useState(false);
    const editorHandleRef = useRef(null);
    const dirty = body !== savedBody;
    const draftKey = planBodyDraftKey(plan.workspaceKey || "unknown", plan.planId);

    useEffect(() => setClientReady(true), []);

    useEffect(() => {
        if (!canEdit) return;
        const stored = readDraft(draftKey);
        if (stored) {
            setDraft(stored);
            if (initialEdit) {
                setMessage("A local draft exists. Restore or discard it before editing this Plan body.");
                setMode("read");
            }
            return;
        }
        if (initialEdit) setMode("edit");
    }, [canEdit, draftKey, initialEdit]);

    useEffect(() => {
        if (!canEdit || !dirty) return undefined;
        const handler = (/** @type {BeforeUnloadEvent} */ event) => {
            event.preventDefault();
            Reflect.set(event, "returnValue", "");
        };
        addEventListener("beforeunload", handler);
        return () => removeEventListener("beforeunload", handler);
    }, [canEdit, dirty]);

    useEffect(() => {
        if (!canEdit || !dirty) return;
        localStorage.setItem(draftKey, serializeDraft({ body, baseBodyHash: expectedBodyHash }));
    }, [body, canEdit, dirty, draftKey, expectedBodyHash]);

    function startEdit() {
        if (!canEdit) return;
        setMessage("");
        setMode("edit");
    }

    function restoreDraft() {
        if (!draft) return;
        setBody(draft.body);
        setExpectedBodyHash(restoredDraftExpectedBodyHash(draft));
        setMessage(
            draft.baseBodyHash === bodyHash
                ? "Draft restored. Review before saving."
                : "Draft restored against its original on-disk version. Saving will require resolving the newer on-disk changes.",
        );
        setMode("edit");
    }

    function discardDraft() {
        localStorage.removeItem(draftKey);
        setDraft(null);
        setMessage("Draft discarded.");
    }

    function cancelEdit() {
        if (dirty && !confirm("Discard unsaved editor changes and local draft?")) return;
        setBody(savedBody);
        setExpectedBodyHash(bodyHash);
        setMode("read");
        if (dirty) discardDraft();
    }

    async function saveBody() {
        setSaving(true);
        setMessage("");
        try {
            const url = new URL(location.href);
            const token = url.searchParams.get(PLAN_UI_TOKEN_QUERY) || "";
            const response = await fetch(`/api/plans/${encodeURIComponent(plan.planId)}/body`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    ...(token ? { [PLAN_UI_TOKEN_HEADER]: token } : {}),
                },
                body: JSON.stringify({ body, expectedBodyHash, expectedRevision }),
            });
            const payload = await response.json();
            if (response.status === 409) {
                setMessage(`${payload.error || "Conflict saving Plan body."} Your local draft was kept.`);
                return;
            }
            if (!response.ok) {
                setMessage(payload.error || "Unable to save Plan body.");
                return;
            }
            const nextHash = payload.bodyHash || payload.plan?.bodyHash || "";
            setExpectedRevision(payload.plan?.revision || expectedRevision);
            setBodyHash(nextHash);
            setExpectedBodyHash(nextHash);
            setSavedBody(body);
            localStorage.removeItem(draftKey);
            setDraft(null);
            setMode("read");
            setMessage("Plan body saved.");
        } finally {
            setSaving(false);
        }
    }

    const recovery = draftRecoveryState(draft, bodyHash);
    const document = clientReady
        ? (
            <Suspense fallback={<MarkdownView markdown={mode === "edit" ? body : savedBody} />}>
                <WorkspacePlanDocument
                    mode={mode}
                    markdown={mode === "edit" ? body : savedBody}
                    documentId={`${plan.planId}:${bodyHash || "initial"}`}
                    editorHandleRef={editorHandleRef}
                    onMarkdownChange={setBody}
                />
            </Suspense>
        )
        : <MarkdownView markdown={savedBody} />;

    return (
        <section className="plan-body-editor" data-editor-mode={mode} data-plannotator-workspace-document>
            <div className="editor-toolbar">
                {mode === "edit"
                    ? (
                        <>
                            <RunWieldButton
                                type="button"
                                variant="primary"
                                disabled={saving || !dirty}
                                onClick={saveBody}
                            >
                                {saving ? <RunWieldThinkingDots label="Saving" /> : "Save"}
                            </RunWieldButton>
                            <RunWieldButton type="button" onClick={cancelEdit}>Cancel</RunWieldButton>
                            <span className={dirty ? "dirty-indicator" : "saved-indicator"}>
                                {dirty ? "Unsaved changes" : "No changes"}
                            </span>
                        </>
                    )
                    : canEdit
                    ? <RunWieldButton type="button" variant="primary" onClick={startEdit}>Edit</RunWieldButton>
                    : null}
            </div>
            {message ? <p className="notice editor-notice">{message}</p> : null}
            {canEdit && draft && mode === "read"
                ? (
                    <div className={recovery === "changed-on-disk" ? "notice warning" : "notice"}>
                        {recovery === "changed-on-disk"
                            ? "A local draft exists, but this Plan changed on disk. Restore only if you want to copy or merge it manually."
                            : "A local unsaved draft is available for this Plan body."}
                        <div className="inline-actions">
                            <RunWieldButton type="button" onClick={restoreDraft}>Restore draft</RunWieldButton>
                            <RunWieldButton type="button" onClick={discardDraft}>Discard draft</RunWieldButton>
                        </div>
                    </div>
                )
                : null}
            <div className={mode === "edit" ? "workspace-plan-document is-editing" : "workspace-plan-document"}>
                {document}
            </div>
        </section>
    );
}

export default PlanBodyEditor;
