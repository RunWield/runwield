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

export function isPublicWorkspaceAsset(pathname: string): boolean {
    return (
        WORKSPACE_PWA_PATHS.includes(pathname) ||
        pathname === "/styles.css" ||
        pathname === "/tokens.css" ||
        pathname === "/components.css" ||
        pathname === "/workspace.css" ||
        pathname === "/workspace-shell.js" ||
        pathname === "/design-system/sidebar-motion.js" ||
        pathname === "/theme.css" ||
        pathname === "/brand/logo.svg" ||
        pathname.startsWith("/_astro/")
    );
}
