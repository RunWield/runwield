// @ts-nocheck: served as plain browser JavaScript from the owner Workspace static route.
import { animateSidebarChange } from "../../design-system/sidebar-motion.js";
export const LAST_SESSION_KEY = "runwield:owner:last-session";
export const LAST_PROJECT_KEY = "runwield:owner:last-project";
export const SIDEBAR_COLLAPSED_KEY = "runwield:owner:sidebar-collapsed";
export const SIDEBAR_WIDTH_KEY = "runwield:owner:sidebar-width";
export const EXPANDED_PLANS_KEY = "runwield:owner:expanded-plans";
export const EXPANDED_PLAN_SESSIONS_KEY = "runwield:owner:expanded-plan-sessions";

export function clampSidebarWidth(width, availableWidth) {
    return Math.round(Math.max(220, Math.min(480, availableWidth - 420, width)));
}

export function installSidebarResize() {
    const shell = document.querySelector(".workspace-shell-with-sidebar");
    if (!shell || shell.querySelector(".workspace-sidebar-resizer")) return;
    const handle = document.createElement("div");
    handle.className = "rw-panel-resize-handle workspace-sidebar-resizer";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-label", "Resize Workspace sidebar");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-valuemin", "220");
    let width = 280;
    try {
        const saved = Number(globalThis.localStorage.getItem(SIDEBAR_WIDTH_KEY));
        if (saved > 0) width = saved;
    } catch {
        /* Layout preferences are optional. */
    }
    const setWidth = (requested, persist = true) => {
        width = clampSidebarWidth(requested, shell.getBoundingClientRect().width);
        shell.style.setProperty("--rw-workspace-sidebar-width", `${width}px`);
        handle.setAttribute("aria-valuenow", String(width));
        handle.setAttribute("aria-valuemax", String(clampSidebarWidth(480, shell.getBoundingClientRect().width)));
        if (persist) {
            try {
                globalThis.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
            } catch {
                /* Optional preference. */
            }
        }
    };
    handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        handle.dataset.resizing = "true";
    });
    handle.addEventListener("pointermove", (event) => {
        if (handle.dataset.resizing !== "true") return;
        setWidth(event.clientX - shell.getBoundingClientRect().left);
    });
    const finish = () => {
        delete handle.dataset.resizing;
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("lostpointercapture", finish);
    handle.addEventListener("keydown", (event) => {
        const requested =
            event.key === "ArrowLeft"
                ? width - 16
                : event.key === "ArrowRight"
                  ? width + 16
                  : event.key === "Home"
                    ? 220
                    : event.key === "End"
                      ? 480
                      : null;
        if (requested === null) return;
        event.preventDefault();
        setWidth(requested);
    });
    handle.addEventListener("dblclick", () => setWidth(280));
    shell.append(handle);
    setWidth(width, false);
}

let overlayDismissInstalled = false;
let sidebarDelegationInstalled = false;
let restoreDelegationInstalled = false;
let refreshGeneration = 0;
let activeSidebarAbort = null;
let activeSidebarUrl = null;
let latestSidebarPayload = null;
const observedSessionNames = new Map();

export function applySessionName(detail) {
    if (!detail?.projectId || !detail.runwieldSessionId || typeof detail.name !== "string") return;
    const name = detail.name.trim();
    observedSessionNames.set(`${detail.projectId}:${detail.runwieldSessionId}`, name);
    const current = currentRoute();
    if (current.projectId === detail.projectId && current.runwieldSessionId === detail.runwieldSessionId) {
        const title = document.querySelector("[data-workspace-main-session-name]");
        if (title) title.textContent = name || "Session";
    }
    for (const row of document.querySelectorAll("[data-sidebar-session]")) {
        if (
            row.dataset.sidebarProjectId !== detail.projectId ||
            row.dataset.sidebarSession !== detail.runwieldSessionId
        )
            continue;
        if (!name) {
            row.remove();
            continue;
        }
        const label = row.querySelector("span");
        if (label) label.textContent = name;
        row.title = name;
    }
}

export function html(value) {
    return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function readStored(key) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || "null");
        return value && typeof value === "object" ? value : null;
    } catch {
        return null;
    }
}

function writeStored(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Last navigation state is only a convenience.
    }
}

function readExpandedSet(key) {
    const stored = readStored(key);
    return new Set(Array.isArray(stored) ? stored.map(String) : []);
}

function writeExpandedSet(key, values) {
    writeStored(key, [...values]);
}

function expansionKey(projectId, childId = "") {
    return childId ? `${projectId}:${childId}` : projectId;
}

export function currentRouteFromUrl(urlLike) {
    const url = urlLike instanceof URL ? urlLike : new URL(String(urlLike), "http://workspace.local");
    const session = /^\/projects\/([^/]+)\/sessions\/([^/?#]+)(?:\/.*)?$/.exec(url.pathname);
    if (session) {
        return {
            projectId: decodeURIComponent(session[1]),
            runwieldSessionId: decodeURIComponent(session[2]),
            kind: "session",
        };
    }
    const board = /^\/projects\/([^/]+)\/plans(?:\/(?:closed|on-hold))?\/?$/.exec(url.pathname);
    if (board) return { projectId: decodeURIComponent(board[1]), kind: "plans" };
    const ownerPlan = /^\/projects\/([^/]+)\/plans\/([^/]+)(?:\/progress)?$/.exec(url.pathname);
    const planSession = url.searchParams.get("session") || "";
    if (ownerPlan && planSession) {
        return {
            projectId: decodeURIComponent(ownerPlan[1]),
            runwieldSessionId: planSession,
            kind: "session",
        };
    }
    if (ownerPlan) {
        return {
            projectId: decodeURIComponent(ownerPlan[1]),
            planId: decodeURIComponent(ownerPlan[2]),
            kind: "plan",
        };
    }
    const project = /^\/projects\/([^/]+)(?:\/|$)/.exec(url.pathname);
    if (project) return { projectId: decodeURIComponent(project[1]), kind: "project" };
    return { kind: "home" };
}

function currentRoute() {
    return currentRouteFromUrl(location.href);
}

function rememberCurrentRoute() {
    const route = currentRoute();
    if (route.kind === "session" && route.projectId && route.runwieldSessionId && route.runwieldSessionId !== "new") {
        writeStored(LAST_PROJECT_KEY, { projectId: route.projectId });
        writeStored(LAST_SESSION_KEY, {
            projectId: route.projectId,
            runwieldSessionId: route.runwieldSessionId,
        });
    } else if (route.projectId) {
        writeStored(LAST_PROJECT_KEY, { projectId: route.projectId });
    }
    updateWorkspaceHomeLinks();
    return route;
}

function updateWorkspaceHomeLinks() {
    const lastSession = readStored(LAST_SESSION_KEY);
    if (!lastSession?.projectId || !lastSession.runwieldSessionId) return;
    for (const link of document.querySelectorAll('[aria-label="RunWield Workspace home"]')) {
        link.href = sessionHref(lastSession.projectId, lastSession.runwieldSessionId);
    }
}

function sessionHref(projectId, sessionId) {
    return `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}

function newSessionHref(projectId) {
    return `/projects/${encodeURIComponent(projectId)}/sessions/new`;
}

function settingsHref(projectId) {
    return `/projects/${encodeURIComponent(projectId)}/settings`;
}

function plansHref(projectId) {
    return `/projects/${encodeURIComponent(projectId)}/plans`;
}

function planHref(projectId, planId) {
    return `/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}`;
}

async function ownerJson(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: { accept: "application/json", ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
    return payload;
}

function sessionStatusLabel(state) {
    const normalized = String(state || "idle").toLowerCase();
    return normalized === "active" || normalized === "busy" ? "busy" : "";
}

function panelCollapseIcon(side) {
    const path = side === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6";
    return `<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><path d="M5 4v16" stroke-width="1.5" stroke-linecap="round"></path><path d="M19 4v16" stroke-width="1.5" stroke-linecap="round"></path><path d="${path}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
}

function isNarrowSidebarMode() {
    return globalThis.matchMedia?.("(max-width: 860px)").matches === true;
}

function setSidebarCollapsed(collapsed) {
    const shell = document.querySelector(".workspace-shell-with-sidebar");
    if (!shell) return;
    shell.classList.toggle("workspace-sidebar-collapsed", collapsed);
    shell.classList.remove("workspace-sidebar-overlay-open");
    try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "true" : "false");
    } catch {
        // Sidebar state is only a convenience.
    }
}

function restoreSidebarPreference() {
    // Filling navigation must not dismiss the mobile drawer the user just opened.
    const shell = document.querySelector(".workspace-shell-with-sidebar");
    if (!shell?.classList.contains("workspace-sidebar-overlay-open")) setSidebarCollapsed(isSidebarCollapsed());
}

function openSidebar() {
    const shell = document.querySelector(".workspace-shell-with-sidebar");
    if (!shell) return;
    if (isNarrowSidebarMode()) {
        shell.classList.remove("workspace-sidebar-collapsed");
        shell.classList.add("workspace-sidebar-overlay-open");
        return;
    }
    setSidebarCollapsed(false);
}

function closeSidebarOverlay() {
    document.querySelector(".workspace-shell-with-sidebar")?.classList.remove("workspace-sidebar-overlay-open");
}

function isSidebarCollapsed() {
    try {
        return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
        return false;
    }
}

function sessionTitleFromPayload(payload, current) {
    if (current.kind !== "session") return "";
    if (current.runwieldSessionId === "new") return "New Session";
    const projects = Array.isArray(payload.projects) ? payload.projects : [];
    const project = projects.find((candidate) => candidate?.projectId === current.projectId);
    const sessions = Array.isArray(project?.sessions) ? project.sessions : [];
    const match = sessions.find((session) => session.runwieldSessionId === current.runwieldSessionId);
    if (match?.displayName) return match.displayName;
    return observedSessionNames.get(`${current.projectId}:${current.runwieldSessionId}`) || "Session";
}

function renderMainHeader(payload, current) {
    const header = document.querySelector("[data-workspace-main-header-left]");
    if (!header) return;
    header.querySelector("[data-workspace-main-session-name]")?.remove();
    const title = header.querySelector("[data-workspace-surface-title]")
        ? ""
        : sessionTitleFromPayload(payload, current);
    let restore = header.querySelector("[data-workspace-sidebar-restore]");
    if (!restore) {
        restore = document.createElement("button");
        restore.className = "rw-icon-button workspace-sidebar-restore";
        restore.type = "button";
        restore.dataset.workspaceSidebarRestore = "";
        restore.setAttribute("aria-label", "Open Workspace sidebar");
        restore.title = "Open Workspace sidebar";
        restore.innerHTML = panelCollapseIcon("right");
        header.prepend(restore);
    }
    if (title) {
        const sessionName = document.createElement("strong");
        sessionName.className = "workspace-main-session-name";
        sessionName.dataset.workspaceMainSessionName = "";
        sessionName.textContent = title;
        header.append(sessionName);
    }
}

function createAnchor(className, href, text) {
    const link = document.createElement("a");
    link.className = className;
    link.href = href;
    link.textContent = text;
    return link;
}

function makeSessionRow(projectId, session, current, extraClass = "") {
    const link = document.createElement("a");
    link.className = `workspace-sidebar-session${extraClass}`;
    link.href = sessionHref(projectId, session.runwieldSessionId);
    link.dataset.sidebarSession = session.runwieldSessionId;
    link.dataset.sidebarProjectId = projectId;
    const label = document.createElement("span");
    label.textContent = session.displayName;
    link.append(label);
    const status = document.createElement("small");
    link.append(status);
    updateSessionRow(link, projectId, session, current, extraClass);
    return link;
}

function updateSessionRow(link, projectId, session, current, extraClass = "") {
    link.href = sessionHref(projectId, session.runwieldSessionId);
    link.dataset.sidebarSession = session.runwieldSessionId;
    link.dataset.sidebarProjectId = projectId;
    const classNames = ["workspace-sidebar-session"];
    if (extraClass) classNames.push(...extraClass.trim().split(/\s+/));
    if (
        current.kind === "session" &&
        current.projectId === projectId &&
        current.runwieldSessionId === session.runwieldSessionId
    )
        classNames.push("active");
    link.className = classNames.join(" ");
    const label = link.querySelector("span") || document.createElement("span");
    label.textContent = session.displayName;
    if (!label.parentElement) link.append(label);
    link.title = label.textContent;
    const status = session.archivedAt ? "Archived" : sessionStatusLabel(session.state);
    let statusNode = link.querySelector("small");
    if (status) {
        if (!statusNode) {
            statusNode = document.createElement("small");
            link.append(statusNode);
        }
        statusNode.textContent = status;
    } else {
        statusNode?.remove();
    }
}

function makeShowMoreButton(projectId) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-sidebar-show-more";
    button.dataset.showMoreSessions = projectId;
    button.textContent = "Show more...";
    return button;
}

function makeEmpty(text) {
    const paragraph = document.createElement("p");
    paragraph.className = "workspace-sidebar-empty";
    paragraph.textContent = text;
    return paragraph;
}

function normalizeProject(project) {
    return {
        projectId: String(project?.projectId || ""),
        displayName: String(project?.displayName || "Untitled Project"),
        enabled: project?.enabled !== false,
        plansLoading: project?.plansLoading === true,
        plansError: project?.plansError === true,
        sessionsLoading: project?.sessionsLoading === true,
        sessionsError: project?.sessionsError === true,
        diagnostics: Array.isArray(project?.diagnostics) ? project.diagnostics : [],
        hasMorePlans: Boolean(project?.hasMorePlans),
        plans: Array.isArray(project?.plans) ? project.plans.filter((plan) => plan?.planId) : [],
        hasMoreSessions: Boolean(project?.hasMoreSessions),
        sessions: Array.isArray(project?.sessions)
            ? project.sessions.filter((session) => session?.runwieldSessionId)
            : [],
    };
}

function snapshotProject(projectElement) {
    const projectId = projectElement.getAttribute("data-sidebar-project") || "";
    return {
        projectId,
        plans: Array.from(projectElement.querySelectorAll("[data-sidebar-plan]")).map((link) => ({
            planId: link.getAttribute("data-sidebar-plan") || "",
        })),
        sessions: Array.from(projectElement.querySelectorAll("[data-sidebar-session]")).map((link) => ({
            runwieldSessionId: link.getAttribute("data-sidebar-session") || "",
            displayName: link.querySelector("span")?.textContent || "",
            state: link.querySelector("small")?.textContent === "busy" ? "busy" : "idle",
            loaded: link.getAttribute("data-sidebar-loaded") === "true",
        })),
    };
}

export function sidebarSessionOrder(existingProject, incomingProject) {
    const incoming = normalizeProject(incomingProject).sessions;
    const seen = new Set(incoming.map((session) => session.runwieldSessionId));
    const retained = (existingProject?.sessions || []).filter(
        (session) => session.runwieldSessionId && session.loaded === true && !seen.has(session.runwieldSessionId),
    );
    return [...incoming, ...retained];
}

export function shouldApplySidebarRefresh(requestGeneration, latestGeneration, requestUrl, currentUrl) {
    return requestGeneration === latestGeneration && String(requestUrl) === String(currentUrl);
}

function ensureSidebarScaffold(sidebar, payload, current) {
    sidebar.querySelectorAll(":scope > .workspace-sidebar-empty").forEach((node) => node.remove());
    let brand = sidebar.querySelector(".workspace-sidebar-brand");
    if (!brand) {
        brand = document.createElement("div");
        brand.className = "workspace-sidebar-brand";
        const home = document.createElement("a");
        home.href = "/";
        home.setAttribute("aria-label", "RunWield Workspace home");
        home.innerHTML = '<img src="/brand/logo.svg" alt="" aria-hidden="true"><span>Workspace</span>';
        brand.append(home);
        sidebar.append(brand);
    }
    if (!brand.querySelector("[data-workspace-sidebar-collapse]")) {
        const collapse = document.createElement("button");
        collapse.className = "rw-icon-button workspace-sidebar-collapse";
        collapse.type = "button";
        collapse.dataset.workspaceSidebarCollapse = "";
        collapse.setAttribute("aria-label", "Collapse Workspace sidebar");
        collapse.title = "Collapse Workspace sidebar";
        collapse.innerHTML = panelCollapseIcon("left");
        brand.append(collapse);
    }
    let home = sidebar.querySelector(".workspace-sidebar-home");
    if (!home) {
        home = createAnchor("workspace-sidebar-home", "/", "Dashboard");
        sidebar.append(home);
    }
    let newSession = sidebar.querySelector(".workspace-sidebar-new");
    if (!newSession) {
        newSession = document.createElement("a");
        newSession.className = "workspace-sidebar-new";
        newSession.innerHTML =
            '<span class="workspace-sidebar-plus" aria-hidden="true">+</span><span>New Session</span>';
        sidebar.append(newSession);
    }
    let section = sidebar.querySelector(".workspace-sidebar-section-title");
    if (!section) {
        section = createAnchor("workspace-sidebar-section-title", "/projects", "Projects");
        sidebar.append(section);
    }
    let list = sidebar.querySelector(".workspace-sidebar-project-list");
    if (!list) {
        list = document.createElement("nav");
        list.className = "workspace-sidebar-project-list";
        list.setAttribute("aria-label", "Projects and Sessions");
        sidebar.append(list);
    }

    const projects = Array.isArray(payload.projects) ? payload.projects : [];
    const rememberedProject = readStored(LAST_PROJECT_KEY)?.projectId || "";
    const enabledProjects = projects.filter((project) => project.enabled);
    const newProjectId =
        enabledProjects.find((project) => project.projectId === current.projectId)?.projectId ||
        enabledProjects.find((project) => project.projectId === rememberedProject)?.projectId ||
        enabledProjects[0]?.projectId ||
        (payload.loading ? current.projectId || rememberedProject : "") ||
        "";
    newSession.href = newProjectId ? newSessionHref(newProjectId) : "/projects";
    newSession.removeAttribute("aria-disabled");
    return list;
}

function makeProjectElement(project, current) {
    const item = document.createElement("details");
    item.className = "workspace-sidebar-project";
    item.dataset.sidebarProject = project.projectId;
    const summary = document.createElement("summary");
    summary.innerHTML = `<span class="workspace-sidebar-folder" aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M5 2l7 6-7 6z" /></svg></span><span class="workspace-sidebar-project-name"></span>`;
    const gear = document.createElement("a");
    gear.className = "workspace-sidebar-gear";
    gear.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" /></svg>`;
    summary.append(gear);
    const links = document.createElement("div");
    links.className = "workspace-sidebar-project-links";
    const diagnostics = document.createElement("div");
    diagnostics.className = "workspace-sidebar-diagnostics";
    const plans = document.createElement("div");
    plans.className = "workspace-sidebar-plans";
    const sessions = document.createElement("div");
    sessions.className = "workspace-sidebar-sessions";
    item.append(summary, links, diagnostics, plans, sessions);
    updateProjectElement(item, project, current);
    return item;
}

function reconcileDiagnostics(container, project) {
    container.replaceChildren();
    for (const diagnostic of project.diagnostics || []) {
        const link = createAnchor(
            "workspace-sidebar-diagnostic",
            diagnostic.repairHref || settingsHref(project.projectId),
            diagnostic.message || "Project needs repair.",
        );
        link.title = diagnostic.repairLabel || "Open Project settings";
        container.append(link);
    }
}

function updateProjectElement(item, project, current) {
    item.dataset.sidebarProject = project.projectId;
    if (current.projectId === project.projectId) item.setAttribute("open", "");
    item.querySelector(".workspace-sidebar-project-name").textContent = project.displayName;
    const gear = item.querySelector(".workspace-sidebar-gear");
    gear.href = settingsHref(project.projectId);
    gear.setAttribute("aria-label", `${project.displayName} settings`);
    const links = item.querySelector(".workspace-sidebar-project-links");
    const projectLink = project.enabled
        ? createAnchor("", plansHref(project.projectId), "All Plans")
        : createAnchor("", settingsHref(project.projectId), "Project unavailable · open settings");
    if (project.enabled) {
        projectLink.dataset.sidebarPlanBoard = project.projectId;
        updatePlanBoardActive(projectLink, current);
    }
    links.replaceChildren(projectLink);
    reconcileDiagnostics(item.querySelector(".workspace-sidebar-diagnostics"), project);
    reconcilePlanRows(item.querySelector(".workspace-sidebar-plans"), project, current);
    reconcileSessionRows(item.querySelector(".workspace-sidebar-sessions"), snapshotProject(item), project, current);
}

function makePlanRow(projectId, plan, current) {
    const wrapper = document.createElement("div");
    wrapper.className = plan.muted ? "workspace-sidebar-plan-group muted" : "workspace-sidebar-plan-group";
    wrapper.dataset.sidebarPlanGroup = plan.planId;
    const row = createAnchor(
        "workspace-sidebar-plan",
        plan.href || planHref(projectId, plan.planId),
        plan.title || "Plan",
    );
    row.dataset.sidebarPlan = plan.planId;
    row.innerHTML = `<span>${html(plan.title || "Plan")}</span><small>${html(
        plan.statusLabel || plan.status || "Plan",
    )}</small>`;
    if (current.kind === "plan" && current.projectId === projectId && current.planId === plan.planId) {
        row.setAttribute("aria-current", "page");
    } else row.removeAttribute("aria-current");
    wrapper.append(row);
    const sessionList = document.createElement("div");
    sessionList.className = "workspace-sidebar-plan-sessions";
    reconcilePlanSessionRows(sessionList, projectId, plan, current);
    wrapper.append(sessionList);
    return wrapper;
}

function reconcilePlanSessionRows(container, projectId, plan, current) {
    const expanded = readExpandedSet(EXPANDED_PLAN_SESSIONS_KEY).has(expansionKey(projectId, plan.planId));
    const sessions = Array.isArray(plan.sessions) ? plan.sessions : [];
    const visible = expanded ? sessions : sessions.slice(0, 2);
    container.replaceChildren();
    for (const session of visible) {
        container.append(makeSessionRow(projectId, session, current, " workspace-sidebar-session-nested"));
    }
    if (sessions.length > visible.length) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "workspace-sidebar-show-more";
        button.dataset.showMorePlanSessions = expansionKey(projectId, plan.planId);
        button.textContent = `Show ${sessions.length - visible.length} more Sessions...`;
        container.append(button);
    }
}

function reconcilePlanRows(container, project, current) {
    const plans = Array.isArray(project.plans) ? project.plans : [];
    const expanded = readExpandedSet(EXPANDED_PLANS_KEY).has(project.projectId);
    const visible = expanded ? plans : plans.slice(0, 5);
    const activePlanKey = document.activeElement?.getAttribute?.("data-sidebar-plan") || "";
    const activeSessionKey = document.activeElement?.getAttribute?.("data-sidebar-session") || "";
    const activeMorePlansKey = document.activeElement?.getAttribute?.("data-show-more-plans") || "";
    const activeMorePlanSessionsKey = document.activeElement?.getAttribute?.("data-show-more-plan-sessions") || "";
    const byId = new Map(
        Array.from(container.querySelectorAll("[data-sidebar-plan-group]")).map((node) => [
            node.getAttribute("data-sidebar-plan-group") || "",
            node,
        ]),
    );
    container
        .querySelectorAll(":scope > .workspace-sidebar-empty, :scope > [data-show-more-plans]")
        .forEach((node) => node.remove());
    const wanted = new Set(visible.map((plan) => plan.planId));
    byId.forEach((node, planId) => {
        if (!wanted.has(planId)) node.remove();
    });
    if (!project.enabled) return;
    if (!plans.length) {
        container.append(
            makeEmpty(
                project.plansLoading
                    ? "Loading Plans…"
                    : project.plansError
                      ? "Plans unavailable."
                      : "No active Plans.",
            ),
        );
        return;
    }
    for (const plan of visible) {
        const node = byId.get(plan.planId) || makePlanRow(project.projectId, plan, current);
        const fresh = makePlanRow(project.projectId, plan, current);
        node.replaceChildren(...Array.from(fresh.childNodes));
        node.className = fresh.className;
        container.append(node);
    }
    if (plans.length > visible.length) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "workspace-sidebar-show-more";
        button.dataset.showMorePlans = project.projectId;
        button.textContent = `Show ${plans.length - visible.length} more Plans...`;
        container.append(button);
    }
    const focusSelectors = activeSessionKey
        ? [`[data-sidebar-session="${CSS.escape(activeSessionKey)}"]`]
        : activePlanKey
          ? [`[data-sidebar-plan="${CSS.escape(activePlanKey)}"]`]
          : activeMorePlansKey
            ? [`[data-show-more-plans="${CSS.escape(activeMorePlansKey)}"]`, "[data-sidebar-plan]"]
            : activeMorePlanSessionsKey
              ? [`[data-show-more-plan-sessions="${CSS.escape(activeMorePlanSessionsKey)}"]`, "[data-sidebar-session]"]
              : [];
    for (const selector of focusSelectors) {
        const focusTarget = container.querySelector(selector);
        if (focusTarget) {
            focusTarget.focus({ preventScroll: true });
            break;
        }
    }
}

function reconcileSessionRows(container, existingProject, project, current) {
    const ordered = project.enabled ? sidebarSessionOrder(existingProject, project) : [];
    const byId = new Map(
        Array.from(container.querySelectorAll("[data-sidebar-session]")).map((row) => [
            row.getAttribute("data-sidebar-session") || "",
            row,
        ]),
    );
    const wantedIds = new Set(ordered.map((session) => session.runwieldSessionId));
    const activeOutsidePage =
        project.enabled &&
        current.kind === "session" &&
        current.projectId === project.projectId &&
        current.runwieldSessionId !== "new" &&
        !wantedIds.has(current.runwieldSessionId) &&
        Boolean(observedSessionNames.get(`${current.projectId}:${current.runwieldSessionId}`));
    if (activeOutsidePage) wantedIds.add(current.runwieldSessionId);

    Array.from(container.querySelectorAll(".workspace-sidebar-empty")).forEach((node) => node.remove());
    Array.from(container.querySelectorAll("[data-sidebar-session]")).forEach((row) => {
        const id = row.getAttribute("data-sidebar-session") || "";
        if (!wantedIds.has(id)) row.remove();
    });

    const nodes = [];
    for (const session of ordered) {
        const retained = byId.get(session.runwieldSessionId);
        const row =
            retained ||
            makeSessionRow(
                project.projectId,
                session,
                current,
                session.loaded ? " workspace-sidebar-session-extra" : "",
            );
        updateSessionRow(
            row,
            project.projectId,
            session,
            current,
            session.loaded ? " workspace-sidebar-session-extra" : "",
        );
        if (session.loaded) row.dataset.sidebarLoaded = "true";
        nodes.push(row);
    }
    if (activeOutsidePage) {
        const session = {
            runwieldSessionId: current.runwieldSessionId,
            displayName: observedSessionNames.get(`${current.projectId}:${current.runwieldSessionId}`) || "",
            state: "idle",
        };
        const row =
            byId.get(current.runwieldSessionId) ||
            makeSessionRow(project.projectId, session, current, " workspace-sidebar-session-extra");
        updateSessionRow(row, project.projectId, session, current, " workspace-sidebar-session-extra");
        nodes.push(row);
    }

    const showMore = container.querySelector("[data-show-more-sessions]") || makeShowMoreButton(project.projectId);
    if (project.enabled && project.hasMoreSessions) {
        showMore.dataset.showMoreSessions = project.projectId;
        if (project.sessions?.some((session) => !byId.has(session.runwieldSessionId))) {
            delete showMore.dataset.sidebarExhausted;
        }
        showMore.hidden = showMore.dataset.sidebarExhausted === "true";
        if (showMore.dataset.sidebarLoading !== "true") {
            showMore.removeAttribute("disabled");
            showMore.textContent = "Show more...";
        }
        nodes.push(showMore);
    } else {
        showMore.remove();
    }

    if (!nodes.length) {
        nodes.push(
            makeEmpty(
                !project.enabled || project.sessionsError
                    ? "Sessions unavailable."
                    : project.sessionsLoading
                      ? "Loading Sessions…"
                      : "No Sessions yet.",
            ),
        );
    }
    for (const node of nodes) container.append(node);
}

export function sidebarProjectOrder(_existingProjects, incomingProjects) {
    return incomingProjects.map(normalizeProject).filter((project) => project.projectId);
}

function reconcileProjects(list, payload, current) {
    const incomingProjects = Array.isArray(payload.projects) ? payload.projects : [];
    const existingProjects = Array.from(list.querySelectorAll("[data-sidebar-project]")).map(snapshotProject);
    const ordered = sidebarProjectOrder(existingProjects, incomingProjects);
    const byId = new Map(
        Array.from(list.querySelectorAll("[data-sidebar-project]")).map((item) => [
            item.getAttribute("data-sidebar-project") || "",
            item,
        ]),
    );
    list.querySelectorAll(":scope > .workspace-sidebar-empty").forEach((node) => node.remove());
    const wantedIds = new Set(ordered.map((project) => project.projectId));
    byId.forEach((node, projectId) => {
        if (!wantedIds.has(projectId)) node.remove();
    });
    if (!ordered.length) {
        list.append(makeEmpty(payload.loading ? "Loading Projects…" : "No Projects registered."));
        return;
    }
    for (const project of ordered) {
        const node = byId.get(project.projectId) || makeProjectElement(project, current);
        updateProjectElement(node, project, current);
        list.append(node);
    }
}

export function renderSidebar(payload, current) {
    const sidebar = document.querySelector("[data-workspace-sidebar]");
    if (!sidebar) return;
    latestSidebarPayload = payload;
    const scrollTop = sidebar.scrollTop;
    renderMainHeader(payload, current);
    const list = ensureSidebarScaffold(sidebar, payload, current);
    reconcileProjects(list, payload, current);
    restoreSidebarPreference();
    updateWorkspaceHomeLinks();
    sidebar.scrollTop = scrollTop;
}

function updatePlanBoardActive(link, current) {
    const active = current.kind === "plans" && link.dataset.sidebarPlanBoard === current.projectId;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
}

export function applyActiveRoute(current) {
    document.querySelectorAll("[data-sidebar-plan-board]").forEach((link) => updatePlanBoardActive(link, current));
    document.querySelectorAll("[data-sidebar-session]").forEach((row) => {
        row.classList.toggle(
            "active",
            current.kind === "session" &&
                row.getAttribute("data-sidebar-project-id") === current.projectId &&
                row.getAttribute("data-sidebar-session") === current.runwieldSessionId,
        );
    });
    document.querySelectorAll("[data-sidebar-plan]").forEach((row) => {
        if (current.kind === "plan" && row.getAttribute("data-sidebar-plan") === current.planId) {
            row.setAttribute("aria-current", "page");
        } else row.removeAttribute("aria-current");
    });
    if (current.projectId) {
        document.querySelector(`[data-sidebar-project="${CSS.escape(current.projectId)}"]`)?.setAttribute("open", "");
    }
}

function installRestoreDelegation() {
    if (restoreDelegationInstalled) return;
    restoreDelegationInstalled = true;
    document.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (!target.closest("[data-workspace-sidebar-restore]")) return;
        event.stopPropagation();
        animateSidebarChange(openSidebar);
    });
}

/** Load one small page; existing rows stay usable while the request is pending. */
export async function loadMoreSidebarSessions(button) {
    if (button.dataset.sidebarLoading === "true") return;
    const projectId = button.getAttribute("data-show-more-sessions") || "";
    const project = button.closest("[data-sidebar-project]");
    const parent = button.closest(".workspace-sidebar-sessions");
    if (!parent) return;
    button.dataset.sidebarLoading = "true";
    button.setAttribute("disabled", "true");
    button.setAttribute("aria-busy", "true");
    button.replaceChildren();
    const loading = document.createElement("span");
    loading.className = "rw-thinking-glyph";
    loading.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = " Loading";
    button.append(loading, label);
    try {
        const query = new URLSearchParams({ pageSize: "5", includeTotal: "false", excludeAssociated: "true" });
        for (const plan of project?.querySelectorAll("[data-sidebar-plan]") || []) {
            const planId = plan.getAttribute("data-sidebar-plan") || "";
            if (planId) query.append("nestedPlan", planId);
        }
        for (const row of parent.querySelectorAll("[data-sidebar-session]")) {
            query.append("excludeSession", row.getAttribute("data-sidebar-session"));
        }
        const data = await ownerJson(`/api/owner/projects/${encodeURIComponent(projectId)}/sessions?${query}`);
        // A refresh may have added a row while the request was pending.
        const known = new Set(
            Array.from(parent.querySelectorAll("[data-sidebar-session]")).map((row) =>
                row.getAttribute("data-sidebar-session"),
            ),
        );
        const rows = (Array.isArray(data.sessions) ? data.sessions : [])
            .filter((session) => session?.runwieldSessionId && !known.has(session.runwieldSessionId))
            .map((session) => {
                const row = makeSessionRow(projectId, session, currentRoute(), " workspace-sidebar-session-extra");
                row.dataset.sidebarLoaded = "true";
                return row;
            });
        button.before(...rows);
        button.dataset.sidebarExhausted = data.hasNext ? "false" : "true";
        button.hidden = !data.hasNext;
        button.textContent = "Show more...";
        button.removeAttribute("title");
    } catch (error) {
        button.textContent = "Retry loading Sessions";
        button.title = error instanceof Error ? error.message : "Could not load Sessions.";
    } finally {
        delete button.dataset.sidebarLoading;
        button.removeAttribute("disabled");
        button.removeAttribute("aria-busy");
    }
}

function installSidebarDelegation() {
    if (sidebarDelegationInstalled) return;
    sidebarDelegationInstalled = true;
    document.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest("[data-workspace-sidebar-collapse]")) {
            animateSidebarChange(() => setSidebarCollapsed(true));
            return;
        }
        const showMorePlans = target.closest("[data-show-more-plans]");
        if (showMorePlans) {
            const projectId = showMorePlans.getAttribute("data-show-more-plans") || "";
            const expanded = readExpandedSet(EXPANDED_PLANS_KEY);
            expanded.add(projectId);
            writeExpandedSet(EXPANDED_PLANS_KEY, expanded);
            installWorkspaceShell();
            return;
        }
        const showMorePlanSessions = target.closest("[data-show-more-plan-sessions]");
        if (showMorePlanSessions) {
            const key = showMorePlanSessions.getAttribute("data-show-more-plan-sessions") || "";
            const expanded = readExpandedSet(EXPANDED_PLAN_SESSIONS_KEY);
            expanded.add(key);
            writeExpandedSet(EXPANDED_PLAN_SESSIONS_KEY, expanded);
            installWorkspaceShell();
            return;
        }
        const showMore = target.closest("[data-show-more-sessions]");
        if (showMore) {
            await loadMoreSidebarSessions(showMore);
        }
    });
}

function installSidebarOverlayDismiss() {
    if (overlayDismissInstalled) return;
    overlayDismissInstalled = true;
    document.addEventListener("click", (event) => {
        const shell = document.querySelector(".workspace-shell-with-sidebar");
        if (!shell?.classList.contains("workspace-sidebar-overlay-open")) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest(".workspace-sidebar")) return;
        animateSidebarChange(closeSidebarOverlay);
    });
}

export async function refreshSidebarForPage() {
    installSidebarOverlayDismiss();
    installSidebarDelegation();
    installRestoreDelegation();
    const current = rememberCurrentRoute();
    const sidebar = document.querySelector("[data-workspace-sidebar]");
    if (!sidebar) return;
    // Navigation controls never wait for a Project, Session, or Plan read.
    if (!latestSidebarPayload || !sidebar.querySelector(".workspace-sidebar-project-list")) {
        renderSidebar({ projects: [], loading: true }, current);
    } else {
        renderMainHeader(latestSidebarPayload || { projects: [] }, current);
        restoreSidebarPreference();
    }
    applyActiveRoute(current);
    // The initial module and Astro's first page-load can arrive during the same request.
    if (activeSidebarAbort && activeSidebarUrl === location.href) return;
    activeSidebarAbort?.abort();
    const abort = new AbortController();
    activeSidebarAbort = abort;
    const requestGeneration = refreshGeneration + 1;
    refreshGeneration = requestGeneration;
    const requestUrl = location.href;
    activeSidebarUrl = requestUrl;
    const isCurrent = () => shouldApplySidebarRefresh(requestGeneration, refreshGeneration, requestUrl, location.href);
    try {
        const catalog = await ownerJson("/api/owner/projects", { signal: abort.signal });
        if (!isCurrent()) return;
        const previous = new Map((latestSidebarPayload?.projects || []).map((project) => [project.projectId, project]));
        const projects = (catalog.projects || []).map((project) => ({
            ...previous.get(project.projectId),
            ...project,
            plansLoading: previous.has(project.projectId)
                ? previous.get(project.projectId).plansLoading === true
                : true,
            sessionsLoading: previous.has(project.projectId)
                ? previous.get(project.projectId).sessionsLoading === true
                : true,
        }));
        const payload = { projects };
        renderSidebar(payload, current);
        let complete = false;
        // Each Project becomes usable independently, before workflow evidence is read.
        const sessions = projects
            .filter(
                (project) =>
                    project.enabled &&
                    (!previous.has(project.projectId) || project.sessionsLoading || project.sessionsError),
            )
            .map(async (project) => {
                try {
                    const result = await ownerJson(
                        `/api/owner/projects/${encodeURIComponent(
                            project.projectId,
                        )}/sessions?pageSize=5&includeTotal=false`,
                        { signal: abort.signal },
                    );
                    if (!isCurrent() || complete) return;
                    // Already-populated navigation stays stable until its complete refresh.
                    project.sessions = result.sessions || [];
                    project.hasMoreSessions = result.hasNext === true;
                    project.sessionsLoading = false;
                    project.sessionsError = false;
                } catch (error) {
                    if (!isCurrent() || complete || error?.name === "AbortError") return;
                    project.sessionsLoading = false;
                    project.sessionsError = true;
                }
                renderSidebar(payload, current);
            });
        const details = (async () => {
            try {
                const full = await ownerJson("/api/owner/sidebar", { signal: abort.signal });
                if (!isCurrent()) return;
                complete = true;
                renderSidebar(full, current);
            } catch (error) {
                if (!isCurrent() || error?.name === "AbortError") return;
                for (const project of projects) {
                    project.plansLoading = false;
                    project.plansError = true;
                }
                renderSidebar(payload, current);
            }
        })();
        await Promise.allSettled([...sessions, details]);
    } catch (error) {
        if (!isCurrent() || error?.name === "AbortError") return;
        const list = sidebar.querySelector(".workspace-sidebar-project-list");
        if (!latestSidebarPayload?.projects?.length) list?.replaceChildren(makeEmpty("Projects failed to load."));
    } finally {
        if (activeSidebarAbort === abort) {
            activeSidebarAbort = null;
            activeSidebarUrl = null;
        }
    }
}

export function installWorkspaceShell() {
    installSidebarResize();
    refreshSidebarForPage();
}

let workspaceShellBrowserInstalled = false;

export function installWorkspaceShellBrowser() {
    if (workspaceShellBrowserInstalled) return;
    workspaceShellBrowserInstalled = true;
    let sidebarScrollTop = 0;
    document.addEventListener("astro:before-swap", () => {
        sidebarScrollTop = document.querySelector("[data-workspace-sidebar]")?.scrollTop || 0;
    });
    document.addEventListener("astro:after-swap", () => {
        const sidebar = document.querySelector("[data-workspace-sidebar]");
        if (sidebar) sidebar.scrollTop = sidebarScrollTop;
    });
    document.addEventListener("runwield:session-named", (event) => applySessionName(event.detail));
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", installWorkspaceShell, { once: true });
    } else installWorkspaceShell();
    document.addEventListener("astro:page-load", installWorkspaceShell);
    document.addEventListener("runwield:session-updated", installWorkspaceShell);
}

if (typeof document !== "undefined") installWorkspaceShellBrowser();
