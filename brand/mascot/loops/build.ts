import { mkdir, readFile, writeFile } from "node:fs/promises";
import { AGENT_MASCOT_ALIASES, animations, HEIGHT, svgPath, terminalLines, WIDTH } from "./sprites.ts";
import { renderRunWieldThemeCss } from "../../../src/ui/design-system/theme-bridge.ts";
function encodeBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8192) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    }
    return btoa(binary);
}

const here = new URL("./", import.meta.url);
const data = animations.map((animation) => ({
    ...animation,
    frames: animation.frames.map((frame) => ({
        ...frame,
        path: svgPath(frame.pixels),
        terminal: terminalLines(frame.pixels),
    })),
    idlePath: svgPath(animation.idle),
    idleTerminal: terminalLines(animation.idle),
    answeringPath: svgPath(animation.answering),
    answeringTerminal: terminalLines(animation.answering),
}));
await mkdir(new URL("exports/", here), { recursive: true });
for (const animation of data) {
    const total = animation.frames.reduce((sum, frame) => sum + frame.duration, 0);
    let elapsed = 0;
    const frames = animation.frames
        .map((frame, index) => {
            const start = (elapsed / total) * 100;
            elapsed += frame.duration;
            const end = (elapsed / total) * 100;
            const css = `@keyframes f${index}{0%,100%{visibility:hidden}${start.toFixed(4)}%,${(end - 0.001).toFixed(
                4,
            )}%{visibility:visible}}`;
            return `<style>${css}</style><path class="frame" style="animation-name:f${index}" d="${frame.path}"/>`;
        })
        .join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="60" height="54" shape-rendering="crispEdges" fill="white"><title>${animation.role} thinking</title><style>.frame{visibility:hidden;animation-duration:${total}ms;animation-timing-function:steps(1,end);animation-iteration-count:infinite}.still{display:none}@media(prefers-reduced-motion:reduce){.frame{display:none}.still{display:inline}}</style>${frames}<path class="still" d="${animation.idlePath}"/></svg>`;
    await writeFile(new URL(`exports/${animation.role}.svg`, here), svg);
}
await writeFile(
    new URL("exports/frames.json", here),
    JSON.stringify(
        {
            width: WIDTH,
            height: HEIGHT,
            agentAliases: AGENT_MASCOT_ALIASES,
            agentInheritance: { delegated: "parent" },
            animations: data,
        },
        null,
        2,
    ),
);
const template = await readFile(new URL("preview.template.html", here), "utf8");
const triage = encodeBase64(await readFile(new URL("../../runwield-tui-triage.png", here)));
const startup = encodeBase64(await readFile(new URL("../../runwield-tui.png", here)));
const html = template
    .replace("/* THEME */", renderRunWieldThemeCss())
    .replace("/* DATA */", `const animations = ${JSON.stringify(data)};`)
    .replace("TRIAGE_IMAGE", `data:image/png;base64,${triage}`)
    .replace("STARTUP_IMAGE", `data:image/png;base64,${startup}`);
await writeFile(new URL("preview.html", here), html);
console.log("Built preview.html, eight animated SVGs and shared one-bit frames.json.");
