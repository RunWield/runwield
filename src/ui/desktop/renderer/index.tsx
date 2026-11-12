import { createRoot } from "react-dom/client";
import { ProjectWorkbench } from "../../workspace/react/ProjectWorkbench.tsx";
import type { DesktopProjectClient } from "../../workspace/client/project-client.ts";
import type { WorkspaceSessionClient } from "../../workspace/client/session-client.ts";
import "virtual:runwield-theme.css";
import "../../design-system/fonts.css";
import "../../design-system/tokens.css";
import "../../design-system/components.css";
import "../../workspace/static/workspace-styles/session-timeline.css";

interface DesktopGlobals {
    runwieldProjects: DesktopProjectClient;
    runwieldSession: WorkspaceSessionClient;
    runwieldLinks: { open(href: string): Promise<void> };
}
const desktop = globalThis as typeof globalThis & DesktopGlobals;
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root.");
createRoot(root).render(<ProjectWorkbench sessions={desktop.runwieldSession} projects={desktop.runwieldProjects} />);
document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    if (!target) return;
    event.preventDefault();
    if (event.isTrusted && event.button === 0 && /^https?:$/.test(target.protocol))
        void desktop.runwieldLinks.open(target.href).catch((error: Error) => console.error(error.message));
});
