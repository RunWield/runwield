import { flushSync } from "react-dom";
import { animateSidebarChange } from "../../sidebar-motion.ts";

export function animateSidebarUpdate(update: () => void) {
    animateSidebarChange(() => flushSync(update));
}
