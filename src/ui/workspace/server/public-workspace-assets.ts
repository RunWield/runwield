/** Public paths shared by Workspace apps and the process review host. */
export const WORKSPACE_PWA_PATHS = [
    "/workspace.webmanifest",
    "/workspace-worker.js",
    "/workspace-pwa.js",
    "/connection-required",
    "/pwa/icon-192.png",
    "/pwa/icon-512.png",
    "/pwa/icon-maskable-512.png",
    "/pwa/apple-touch-icon.png",
];

export const SIDEBAR_MOTION_URL = "/design-system/sidebar-motion.js";
export const SIDEBAR_MOTION_SOURCE = "src/ui/design-system/sidebar-motion.ts";

export function isPublicWorkspaceAsset(pathname: string): boolean {
    return (
        WORKSPACE_PWA_PATHS.includes(pathname) ||
        pathname === "/styles.css" ||
        pathname === "/tokens.css" ||
        pathname === "/components.css" ||
        pathname === "/workspace.css" ||
        pathname === "/workspace-shell.js" ||
        pathname === SIDEBAR_MOTION_URL ||
        pathname === "/design-system/panel-icon.ts" ||
        pathname === "/theme.css" ||
        pathname === "/brand/logo.svg" ||
        pathname.startsWith("/_astro/")
    );
}

/** Serve the typed sidebar module at the browser's JavaScript import URL. */
export function transpileSidebarMotionScript(source: string): string {
    return new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);
}
