import { writeFile } from "node:fs/promises";
import { animations, svgPath } from "../../../src/ui/mascot/frames.ts";

// README companions use the approved pixels, with a quieter reading pace for Reviewer.
const here = new URL("./", import.meta.url);
for (const role of ["base", "reviewer"] as const) {
    const animation = animations.find((item) => item.role === role)!;
    const total = animation.frames.reduce((sum, frame) => sum + frame.duration, 0);
    let elapsed = 0;
    const keyframes: string[] = [];
    const paths = animation.frames
        .map((frame, index) => {
            const start = (elapsed / total) * 100;
            elapsed += frame.duration;
            const end = (elapsed / total) * 100;
            keyframes.push(
                `@keyframes f${index}{0%,100%{visibility:hidden}${start.toFixed(4)}%,${(end - 0.001).toFixed(
                    4,
                )}%{visibility:visible}}`,
            );
            return `<path class="frame" style="animation-name:f${index}" d="${svgPath(frame.pixels)}"/>`;
        })
        .join("\n");
    const title =
        role === "base" ? "Oh, hello. A blinking RunWield companion." : "Just reading along. RunWield Reviewer.";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 18" width="80" height="72" shape-rendering="crispEdges">
<title>${title}</title>
<style>
svg{fill:#000}
@media(prefers-color-scheme:dark){svg{fill:#fff}}
.frame{visibility:hidden;animation-duration:${
        total * (role === "reviewer" ? 2 : 1)
    }ms;animation-timing-function:steps(1,end);animation-iteration-count:infinite}
.still{display:none}
${keyframes.join("\n")}
@media(prefers-reduced-motion:reduce){.frame{display:none}.still{display:inline}}
</style>
${paths}
<path class="still" d="${svgPath(animation.idle)}"/>
</svg>\n`;
    await writeFile(new URL(`${role}.svg`, here), svg);
}
