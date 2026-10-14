import { readFile as fsReadFile } from "node:fs/promises";
import { Window } from "happy-dom";

const dashboard = await fsReadFile(new URL("./components/OwnerDashboard.astro", import.meta.url), "utf8");
const section = await fsReadFile(new URL("./components/DashboardSection.astro", import.meta.url), "utf8");
const coordinatorScript = dashboard.match(/<script is:inline data-astro-rerun>([\s\S]*?)<\/script>/)?.[1];
const islandScript = section.match(/<script is:inline data-astro-rerun>([\s\S]*?)<\/script>/)?.[1];
export const markup = dashboard.slice(
    dashboard.indexOf('<section class="owner-dashboard"'),
    dashboard.indexOf("<script is:inline"),
)
    .replace(
        /<DashboardSection sectionKey="([^"]+)" label="([^"]+)" index=\{(\d+)\} \/>/g,
        (_, key, label, index) =>
            section.slice(
                section.indexOf('<section class="owner-dashboard-section"'),
                section.indexOf("<script is:inline"),
            )
                .replace("={sectionKey}", '="' + key + '"').replace("={label}", '="' + label + '"').replace(
                    "={index}",
                    '="' + index + '"',
                )
                .replace("{label}", label) + "<script data-dashboard-island></script>",
    );

export function mountDashboard(window: Window) {
    if (!coordinatorScript || !islandScript) throw new Error("Dashboard script is missing");
    window.document.body.innerHTML = markup;
    for (const script of window.document.querySelectorAll("[data-dashboard-island]")) {
        Object.defineProperty(window.document, "currentScript", { configurable: true, value: script });
        window.eval(islandScript);
    }
    Object.defineProperty(window.document, "currentScript", { configurable: true, value: null });
    window.eval(coordinatorScript);
}

export function newDashboardWindow() {
    return new Window({ url: "http://workspace.test/" });
}
