export type SidebarTransition = Pick<ViewTransition, "finished" | "ready" | "skipTransition">;

let activeTransition: SidebarTransition | null = null;
type SidebarUpdate = () => void;
let pendingUpdates: SidebarUpdate[] | null = null;

/**
 * Animate a sidebar layout change without retaining hidden interactive content.
 * Call only for user actions; initial state and responsive layout changes stay instant.
 */
export function animateSidebarChange(update: SidebarUpdate) {
    if (
        typeof document === "undefined" ||
        !document.startViewTransition ||
        globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
        update();
        return;
    }
    if (pendingUpdates) {
        pendingUpdates.push(update);
        return;
    }
    if (activeTransition) {
        activeTransition.skipTransition();
        update();
        return;
    }
    const root = document.documentElement;
    // The shell and React islands can load separate copies of this module.
    if (root.classList.contains("rw-sidebar-motion")) {
        update();
        return;
    }
    root.classList.add("rw-sidebar-motion");
    pendingUpdates = [update];
    const transition = document.startViewTransition(() => {
        const updates = pendingUpdates || [];
        pendingUpdates = null;
        for (const apply of updates) apply();
    });
    activeTransition = transition;
    // Hidden tabs or a navigation can skip the animation; the update still runs.
    transition.ready.catch(() => {});
    const finish = () => {
        if (activeTransition !== transition) return;
        activeTransition = null;
        root.classList.remove("rw-sidebar-motion");
    };
    transition.finished.then(finish, finish);
}
