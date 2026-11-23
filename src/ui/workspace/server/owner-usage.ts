import { isProjectAvailable } from "../project-availability.ts";
import { loadUsageSummary } from "./owner-usage-settings.ts";
import { queryUsageReport } from "../../../shared/workflow/usage-reporting.ts";
import type { ProjectRegistry } from "@runwield/projects";
import type { UsageLink } from "../../../shared/workflow/usage-reporting.ts";
import { listOwnerProjects, requireOwnerProjectRoot, sessionBelongsToOwnerProject } from "./owner-projects.ts";
import type { OwnerProjectStore } from "./owner-projects.ts";
import type { FileSessionStore } from "../../../shared/session/file-session-store-types.ts";
import { loadWorkspaceDetail } from "./plan-adapter.ts";

interface UsageOwnerStore extends OwnerProjectStore {
    projects: OwnerProjectStore["projects"] & Pick<ProjectRegistry, "listRootEvidence">;
    listProjectSessions: FileSessionStore["listProjectSessions"];
}

interface UsageDestination {
    href: string;
    label?: string;
}

export interface OwnerUsageLink extends UsageLink {
    sessionHref?: string;
    planHref?: string;
    sessionLabel?: string;
    planLabel?: string;
}

function shiftDate(date: string, days: number) {
    const value = new Date(`${date}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

/** Authorization and local labels belong here; all measurement arithmetic stays in Core. */
export async function loadOwnerUsageReport(store: UsageOwnerStore, params: URLSearchParams) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
    const preset = params.get("preset") || "30";
    const custom = params.has("start") || params.has("end");
    if (!custom && !["7", "30", "90"].includes(preset)) throw new Error("Choose a valid usage period.");
    const period = custom
        ? { start: params.get("start") || "", end: params.get("end") || "" }
        : { start: shiftDate(today, 1 - Number(preset)), end: shiftDate(today, 1) };
    const projects = listOwnerProjects(store);
    const selectedId = params.get("projectId");
    if (selectedId && !projects.some((project) => project.projectId === selectedId && isProjectAvailable(project))) {
        throw new Error("Usage Project is not registered, active, and available.");
    }
    const authorized = projects.filter(
        (project) => isProjectAvailable(project) && (!selectedId || project.projectId === selectedId),
    );
    const registrations = new Map(
        authorized.map((owner) => [owner.projectId, { owner, root: requireOwnerProjectRoot(store, owner.projectId) }]),
    );
    const report = queryUsageReport(
        [...registrations.values()].map(({ root }) => root),
        period,
        timeZone,
    );
    const enriched = await Promise.all(
        report.projects.map(async (project) => {
            const registration = registrations.get(project.projectId);
            if (!registration) throw new Error("Registered Project identity changed. Refresh Usage.");
            const { owner, root } = registration;
            const projectHref = `/projects/${encodeURIComponent(owner.projectId)}`;
            const labels = new Set([owner.displayName || owner.rootLabel]);
            for (const evidence of store.projects.listRootEvidence(owner.projectId)) labels.add(evidence.displayName);
            const planDestinations = new Map<string, Promise<UsageDestination | undefined>>();
            const sessionIds = new Set(
                [...project.links, ...project.incomplete, ...project.ongoing].flatMap((link) =>
                    link.sessionId ? [link.sessionId] : [],
                ),
            );
            const sessionDestinations = new Map<string, UsageDestination>();
            if (sessionIds.size) {
                const listed = await store.listProjectSessions(owner.projectId, {
                    all: true,
                    archiveState: "all",
                    catalog: false,
                });
                for (const session of listed.sessions) {
                    const id = session.runwieldSessionId;
                    if (!sessionIds.has(id) || !sessionBelongsToOwnerProject(store, session, owner.projectId)) continue;
                    sessionDestinations.set(id, {
                        href: `${projectHref}/sessions/${encodeURIComponent(id)}`,
                        label: session.displayName || undefined,
                    });
                }
            }
            async function destination(link: UsageLink): Promise<OwnerUsageLink> {
                const session = link.sessionId ? sessionDestinations.get(link.sessionId) : undefined;
                if (link.planId && !planDestinations.has(link.planId)) {
                    const planId = link.planId;
                    planDestinations.set(
                        planId,
                        (async () => {
                            try {
                                const detail = await loadWorkspaceDetail(root, planId, { reviewOnly: true });
                                return {
                                    href: `${projectHref}/plans/${encodeURIComponent(planId)}`,
                                    label: detail.title,
                                };
                            } catch {
                                return undefined;
                            }
                        })(),
                    );
                }
                const plan = link.planId ? await planDestinations.get(link.planId) : undefined;
                return {
                    ...link,
                    projectId: owner.projectId,
                    sessionHref: session?.href,
                    sessionLabel: session?.label,
                    planHref: plan?.href,
                    planLabel: plan?.label,
                };
            }
            return {
                ...project,
                projectId: owner.projectId,
                aliases: [...labels].map((label) => ({ projectId: owner.projectId, label })),
                links: await Promise.all(project.links.map(destination)),
                incomplete: await Promise.all(project.incomplete.map(destination)),
                ongoing: await Promise.all(project.ongoing.map(destination)),
            };
        }),
    );
    return {
        ...report,
        projects: enriched,
        availableProjects: projects.filter(isProjectAvailable),
        excludedProjects: projects
            .filter((project) => !isProjectAvailable(project) || (selectedId && project.projectId !== selectedId))
            .map((project) => ({
                ...project,
                exclusionReason: isProjectAvailable(project)
                    ? "not selected"
                    : project.status === "inactive"
                      ? project.status
                      : project.healthStatus,
            })),
    };
}

export async function loadOwnerUsage(store: UsageOwnerStore, params: URLSearchParams) {
    return { ...(await loadOwnerUsageReport(store, params)), ...(await loadUsageSummary(store)) };
}

export type OwnerUsageReport = Awaited<ReturnType<typeof loadOwnerUsage>>;
