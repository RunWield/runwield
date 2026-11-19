import source from "../../../design-system/sidebar-motion.ts?raw";
import { transpileSidebarMotionScript } from "../../server/public-workspace-assets.ts";

export const prerender = false;

export const GET = () =>
    new Response(transpileSidebarMotionScript(source), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
    });
