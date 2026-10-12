import { queryUsageReport, usageProjectIdentityForRoot } from "../../../shared/workflow/usage-reporting.ts";
import type { UsageLink } from "../../../shared/workflow/usage-reporting.ts";
import { listOwnerProjects, requireOwnerProjectRoot, sessionBelongsToOwnerProject } from "./owner-projects.ts";
import type { OwnerProjectSession, OwnerProjectStore } from "./owner-projects.ts";
import { loadWorkspaceDetail } from "./plan-adapter.js";

interface UsageOwnerSession extends OwnerProjectSession {
    displayName?: string | null;
}

interface UsageOwnerStore extends OwnerProjectStore {
    getSessionById(sessionId: string, projectId: string): UsageOwnerSession | null;
}

interface UsageDestination {
    href: string;
    label: string;
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
export async function loadOwnerUsage(store: UsageOwnerStore, params: URLSearchParams) {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
        .format(new Date());
    const preset = params.get("preset") || "30";
    const custom = params.has("start") || params.has("end");
    if (!custom && !["7", "30", "90"].includes(preset)) throw new Error("Choose a valid usage period.");
    const period = custom
        ? { start: params.get("start") || "", end: params.get("end") || "" }
        : { start: shiftDate(today, 1 - Number(preset)), end: shiftDate(today, 1) };
    const projects = listOwnerProjects(store);
    const selectedId = params.get("projectId");
    if (selectedId && !projects.some((project) => project.projectId === selectedId && project.enabled)) {
        throw new Error("Usage Project is not registered, enabled, and available.");
    }
    const authorized = projects.filter((project) =>
        project.enabled && (!selectedId || project.projectId === selectedId)
    );
    const roots = authorized.map((project) => requireOwnerProjectRoot(store, project.projectId));
    const identities = roots.map(usageProjectIdentityForRoot);
    const report = queryUsageReport(roots, period, timeZone);
    const enriched = await Promise.all(report.projects.map(async (project) => {
        const indexes = identities.flatMap((identity, index) => identity === project.projectId ? [index] : []);
        const aliases = indexes.map((index) => authorized[index]);
        const owner = aliases[0];
        const planDestinations = new Map<string, Promise<UsageDestination | undefined>>();
        async function destination(link: UsageLink): Promise<OwnerUsageLink> {
            const sessionTarget = link.sessionId
                ? aliases.map((alias) => ({
                    projectId: alias.projectId,
                    session: store.getSessionById(link.sessionId!, alias.projectId),
                })).find((target) =>
                    target.session && sessionBelongsToOwnerProject(store, target.session, target.projectId)
                )
                : undefined;
            const sessionHref = sessionTarget
                ? `/projects/${encodeURIComponent(sessionTarget.projectId)}/sessions/${
                    encodeURIComponent(link.sessionId!)
                }`
                : undefined;
            if (link.planId && !planDestinations.has(link.planId)) {
                const planId = link.planId;
                planDestinations.set(
                    planId,
                    (async () => {
                        for (const index of indexes) {
                            try {
                                const detail = await loadWorkspaceDetail(roots[index], planId, { reviewOnly: true });
                                return {
                                    href: `/projects/${encodeURIComponent(authorized[index].projectId)}/plans/${
                                        encodeURIComponent(planId)
                                    }`,
                                    label: detail.title,
                                };
                            } catch { /* A target can exist only in another authorized checkout. */ }
                        }
                        return undefined;
                    })(),
                );
            }
            const plan = link.planId ? await planDestinations.get(link.planId) : undefined;
            return {
                ...link,
                projectId: owner.projectId,
                sessionHref,
                sessionLabel: sessionTarget?.session?.displayName || undefined,
                planHref: plan?.href,
                planLabel: plan?.label,
            };
        }
        return {
            ...project,
            projectId: owner.projectId,
            aliases: aliases.map((alias) => ({
                projectId: alias.projectId,
                label: alias.displayName || alias.rootLabel,
            })),
            links: await Promise.all(project.links.map(destination)),
            incomplete: await Promise.all(project.incomplete.map(destination)),
            ongoing: await Promise.all(project.ongoing.map(destination)),
        };
    }));
    return {
        ...report,
        projects: enriched,
        availableProjects: projects.filter((project) => project.enabled),
        excludedProjects: projects.filter((project) =>
            !project.enabled || (selectedId && project.projectId !== selectedId)
        )
            .map((project) => ({
                ...project,
                exclusionReason: project.enabled
                    ? "not selected"
                    : project.lifecycle === "enabled"
                    ? project.healthStatus
                    : project.lifecycle,
            })),
    };
}

export type OwnerUsageReport = Awaited<ReturnType<typeof loadOwnerUsage>>;
