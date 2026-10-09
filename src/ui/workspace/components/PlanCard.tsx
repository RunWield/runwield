import { PLAN_SEARCH_QUERY_PARAM, PLAN_UI_TOKEN_QUERY } from "../constants.ts";
import { RunWieldCard } from "../../design-system/components/react/RunWieldPrimitives.tsx";

export interface PlanLinkTarget {
    planId: string;
}

export interface PlanCardDragActions {
    allowedTargetStatuses?: string[];
}

export interface PlanCardActions {
    dnd?: PlanCardDragActions;
    allowedManualTargetStatuses?: string[];
}

export interface PlanCardData extends PlanLinkTarget {
    planName: string;
    status: string;
    hierarchyRole?: string;
    complexity?: string;
    summary?: string;
    heldFromStatus?: string;
    heldAt?: string;
    holdReason?: string;
    blockedByDependencies?: boolean;
    unverifiedDependencyCount?: number;
    missingDependencyCount?: number;
    actions?: PlanCardActions;
}

export interface ComplexityLabelProps {
    complexity: string;
}

export interface PlanCardProps {
    plan: PlanCardData;
    url: URL | string;
    compact?: boolean;
    roleLabel?: string;
    draggableCard?: boolean;
}

export function workspaceUrl(url: URL | string) {
    return url instanceof URL ? url : new URL(String(url));
}

export function workspaceHref(path: string, url: URL | string) {
    const currentUrl = workspaceUrl(url);
    const ownerMatch = currentUrl.pathname.match(/^\/projects\/([^/]+)\/plans(?:\/(?:closed|on-hold))?(?:\/[^/]*)?$/);
    const isOwnerProjectPlanRoute = Boolean(ownerMatch);
    let nextPath = path;
    if (ownerMatch) {
        const projectBase = `/projects/${ownerMatch[1]}/plans`;
        if (path === "/") nextPath = projectBase;
        else if (path === "/closed") nextPath = `${projectBase}/closed`;
        else if (path === "/on-hold") nextPath = `${projectBase}/on-hold`;
        else if (path.startsWith("/plans/")) nextPath = `${projectBase}/${path.slice("/plans/".length)}`;
    }
    const next = new URL(nextPath, currentUrl);
    const token = isOwnerProjectPlanRoute ? "" : currentUrl.searchParams.get(PLAN_UI_TOKEN_QUERY) || "";
    const query = currentUrl.searchParams.get(PLAN_SEARCH_QUERY_PARAM) || "";
    if (token) next.searchParams.set(PLAN_UI_TOKEN_QUERY, token);
    if (query) next.searchParams.set(PLAN_SEARCH_QUERY_PARAM, query);
    return `${next.pathname}${next.search}`;
}

export function detailHref(plan: PlanLinkTarget, url: URL | string) {
    return workspaceHref(`/plans/${encodeURIComponent(plan.planId)}`, url);
}

export function editBodyHref(plan: PlanLinkTarget, url: URL | string) {
    return workspaceHref(`/plans/${encodeURIComponent(plan.planId)}?edit=body`, url);
}

function holdMetadata(plan: PlanCardData) {
    const metadata = [];
    if (plan.heldFromStatus) metadata.push(`held from ${plan.heldFromStatus}`);
    if (plan.heldAt) metadata.push(`held at ${plan.heldAt}`);
    if (plan.holdReason) metadata.push(`reason: ${plan.holdReason}`);
    return metadata.length ? metadata.join("; ") : "No hold metadata provided.";
}

const COMPLEXITY_CLASS_BY_VALUE: Record<string, string> = {
    LOW: "complexity-low",
    MEDIUM: "complexity-medium",
    HIGH: "complexity-high",
};

export function complexityClassName(complexity: string) {
    const key = String(complexity || "").toUpperCase();
    return `complexity-label ${COMPLEXITY_CLASS_BY_VALUE[key] || "complexity-unknown"}`;
}

export function ComplexityLabel({ complexity }: ComplexityLabelProps) {
    return <span className={complexityClassName(complexity)}>{complexity}</span>;
}

export function PlanCard({ plan, url, compact = false, roleLabel = "Plan", draggableCard = false }: PlanCardProps) {
    const isChildCard = plan.hierarchyRole === "child" || plan.hierarchyRole === "orphan-child";
    const href = detailHref(plan, url);
    const allowedTargetStatuses =
        (plan.actions?.dnd?.allowedTargetStatuses || plan.actions?.allowedManualTargetStatuses || [])
            .join(" ");
    const canDrag = draggableCard && Boolean(allowedTargetStatuses);
    return (
        <RunWieldCard
            className={compact ? "compact clickable-card" : "clickable-card"}
            data-draggable-plan-card={canDrag ? "true" : undefined}
            draggable={canDrag}
            data-plan-id={plan.planId}
            data-plan-search-card={plan.planId}
            data-plan-name={plan.planName}
            data-status={plan.status}
            data-allowed-target-statuses={canDrag ? allowedTargetStatuses : undefined}
            aria-describedby={canDrag ? `drag-help-${plan.planId}` : undefined}
        >
            <a className="card-hit-area" href={href} aria-label={`Open ${plan.planName} details`}></a>
            <div className="card-header">
                <div>
                    <p className="card-kicker">
                        <span>{roleLabel}</span>
                        {plan.complexity ? <ComplexityLabel complexity={plan.complexity} /> : null}
                    </p>
                    <span className="card-title">{plan.planName}</span>
                </div>
                {canDrag
                    ? (
                        <span className="drag-grip" aria-hidden="true" title="Drag to move status">
                            ⋮⋮
                        </span>
                    )
                    : null}
            </div>
            {canDrag
                ? (
                    <span id={`drag-help-${plan.planId}`} className="sr-only">
                        Drag this Plan Card to an allowed status column: {allowedTargetStatuses.replaceAll(" ", ", ")}.
                    </span>
                )
                : null}
            <p>{plan.summary || "No summary provided."}</p>
            {plan.status === "on_hold" ? <p className="hold-summary">{holdMetadata(plan)}</p> : null}
            <div className="badge-row">
                {plan.blockedByDependencies ? <span className="badge warning">Blocked by dependency</span> : null}
                {plan.unverifiedDependencyCount
                    ? <span className="badge warning">{plan.unverifiedDependencyCount} unverified dependency</span>
                    : null}
                {plan.missingDependencyCount
                    ? <span className="badge danger">{plan.missingDependencyCount} missing dependency</span>
                    : null}
                {plan.hierarchyRole === "orphan-child"
                    ? <span className="badge warning">Missing parent Epic</span>
                    : null}
                {isChildCard && plan.status === "on_hold" ? <span className="badge muted">Child on hold</span> : null}
                {isChildCard && plan.status === "failed" ? <span className="badge danger">Failed child</span> : null}
            </div>
        </RunWieldCard>
    );
}
