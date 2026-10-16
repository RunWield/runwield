/** Approved, shared one-bit mascot frames for terminal and browser surfaces. */
export const WIDTH = 20;
export const HEIGHT = 18;
export const ROLES = ["base", "guide", "planner", "architect", "engineer", "operator", "reviewer", "ideator"] as const;
export type Role = (typeof ROLES)[number];
export const AGENT_MASCOT_ALIASES: Readonly<Record<string, Role>> = {
    init: "base",
    router: "base",
    slicer: "planner",
    "plan-engineer": "engineer",
    "frontend-engineer": "engineer",
    "reviewer-feedback-engineer": "engineer",
    "validation-repair-engineer": "engineer",
    "manual-qa": "operator",
};
/** Delegated callers supply the parent identity, or the inherited ancestor identity for nested delegation. */
export function mascotRoleForAgent(agentName: string, parentAgentName?: string): Role | undefined {
    const normalize = (name: string) => name.trim().toLowerCase().replaceAll(" ", "-");
    const name = normalize(agentName);
    const owner = name === "delegated" ? normalize(parentAgentName || "") : name;
    if (!owner || owner === "recorder" || owner === "tester") return undefined;
    if (owner === "engineer" || owner.endsWith("-engineer")) return "engineer";
    return AGENT_MASCOT_ALIASES[owner] || ROLES.find((role) => role === owner) || "base";
}
export type Pose = "thinking" | "idle" | "answering";
export interface Frame {
    pixels: string[];
    duration: number;
}
export interface Animation {
    role: Role;
    frames: Frame[];
    idle: string[];
    answering: string[];
}

const BODY = [
    "##.........##",
    "###.......###",
    ".###########.",
    ".###.....###.",
    ".##.......##.",
    ".##.......##.",
    ".##.......##.",
    ".###.....###.",
    "..#########..",
    "..#########..",
    "..####.####..",
    "...##...##...",
    "...##...##...",
];

export function pixelsFor(role: Role, frame: number, pose: Pose = "thinking"): string[] {
    const grid = Array.from({ length: HEIGHT }, () => Array(WIDTH).fill("."));
    function rect(x: number, y: number, width: number, height: number, ink = "#") {
        for (let row = y; row < y + height; row++) {
            for (let col = x; col < x + width; col++) {
                if (row >= 0 && row < HEIGHT && col >= 0 && col < WIDTH) grid[row][col] = ink;
            }
        }
    }
    function stamp(x: number, y: number, rows: string[]) {
        rows.forEach((row, dy) => [...row].forEach((pixel, dx) => rect(x + dx, y + dy, 1, 1, pixel)));
    }
    stamp(0, 3, BODY);
    // Leave a black pixel between the moving eyes and the white face border.
    rect(2, 7, 9, 3, ".");
    const step = pose === "thinking" ? frame % 6 : 1;
    const eyeOffset =
        role === "reviewer" ? [-1, 0, 1, 1, -1, -1][step] : role === "operator" && (step === 2 || step === 3) ? 1 : 0;
    const baseStep = frame % 8;
    const blink =
        pose === "thinking" &&
        role !== "reviewer" &&
        (role === "base" ? baseStep === 2 || baseStep === 6 : role === "architect" ? frame === 11 : step === 5);
    rect(4 + eyeOffset, 8, 2, blink ? 1 : 2);
    rect(7 + eyeOffset, 8, 2, blink ? 1 : 2);
    if (role === "base" && (pose !== "thinking" || Math.floor(baseStep / 2) % 2 === 0)) rect(15, 14, 2, 2);
    if (role === "guide") {
        rect(14, 8, 1, 6);
        stamp(13, 4, [".#####.", "#######", "#######", "#######", ".#####."]);
        const right = step < 3;
        stamp(14, 5, right ? ["..#..", "####.", "..#.."] : ["..#..", ".####", "..#.."]);
        // Arrow is punched out of the solid paddle.
        rect(14, 5, 5, 3);
        rect(right ? 16 : 15, 5, 1, 3, ".");
        rect(14, 6, 4, 1, ".");
        rect(right ? 17 : 14, 6, 1, 1, ".");
    }
    if (role === "planner") {
        stamp(14, 7, ["..##..", ".####.", "######", "#....#", "######", "#....#", "######", "#....#", "######"]);
        rect(15 + (step % 3), 10 + (step >= 3 ? 2 : 0), 1, 1);
    }
    if (role === "architect") {
        const block = ["###", "#.#", "###"];
        const columns = [13, 17, 15];
        const landedRows = [14, 14, 10];
        if (pose !== "thinking") {
            columns.forEach((x, index) => stamp(x, landedRows[index], block));
        } else {
            const constructionFrame = frame % 13;
            // Three four-frame drops, then one empty frame before rebuilding.
            if (constructionFrame < 12) {
                const dropping = Math.floor(constructionFrame / 4);
                for (let index = 0; index < dropping; index++) {
                    stamp(columns[index], landedRows[index], block);
                }
                const fallRows = dropping === 2 ? [0, 3, 7, 10] : [2, 6, 10, 14];
                stamp(columns[dropping], fallRows[constructionFrame % 4], block);
            }
        }
    }
    if (role === "engineer") {
        rect(0, 14, 14, 4, ".");
        stamp(0, 15, ["##############", "#.#.#.#.#.#..#", "##############"]);
        rect(2, step % 2 ? 13 : 14, 2, 1);
        rect(9, step % 2 ? 14 : 13, 2, 1);
    }
    /* Preserved gear option: restore this block and six 220 ms frames.
    if (role === "operator") {
        // Six broad teeth turn around a fixed, open hub. One loop advances 60°.
        const angle = (pose === "thinking" ? step : 0) * Math.PI / 18;
        for (let y = -3.5; y <= 3.5; y++) {
            for (let x = -3.5; x <= 3.5; x++) {
                const radius = Math.hypot(x, y);
                const tooth = Math.cos(6 * (Math.atan2(y, x) - angle)) > 0.1;
                if (radius > 1.2 && (radius <= 2.8 || (radius <= 3.95 && tooth))) {
                    rect(15.5 + x, 11.5 + y, 1, 1);
                }
            }
        }
    }
    */
    if (role === "operator") {
        // A rigid shaft pivots on a fixed pedestal; hold at each end of its travel.
        const tilt = pose === "thinking" ? [-1, -1, 0, 1, 1, 0][step] : 0;
        const tipX = 16 + tilt * 2;
        const tipY = tilt === 0 ? 8 : 9;
        for (let y = tipY; y <= 14; y++) {
            const x = Math.round(tipX + ((16 - tipX) * (y - tipY)) / (14 - tipY));
            rect(x, y, 1, 1);
        }
        rect(tipX - 1, tipY - 1, 3, 2);
        rect(15, 14, 3, 2);
        rect(13, 16, 7, 1);
    }
    if (role === "reviewer") {
        rect(2, 11, 10, 7, ".");
        stamp(3, 11, [".######.", "##.#####", ".######.", ".######.", ".######.", ".######.", ".#####.#"]);
        rect(3, 17, 8, 1);
        rect(3, 16, 1, 1);
        rect(5, 12 + (step >= 4 ? 0 : 1), 4, 1, ".");
        rect(5, 14 + (step >= 4 ? 0 : 1), 4, 1, ".");
    }
    if (role === "ideator") {
        stamp(13, 0, [
            "..####.",
            ".#....#",
            "#......",
            "#......",
            ".#....#",
            "..####.",
            ".......",
            "..####.",
            "...##..",
        ]);
        rect(19, 2, 1, 2);
        const fill = pose === "answering" ? 4 : pose === "idle" ? 0 : [0, 1, 2, 3, 4, 2, 0][step];
        for (let row = 5 - fill; row < 5; row++) {
            const wide = row === 2 || row === 3;
            rect(wide ? 14 : 15, row, wide ? 5 : 4, 1);
        }
    }
    return grid.map((row) => row.join(""));
}

export const animations: Animation[] = ROLES.map((role) => ({
    role,
    frames: (role === "architect"
        ? [70, 70, 70, 260, 70, 70, 70, 260, 70, 70, 70, 500, 280]
        : role === "base"
          ? [300, 300, 300, 300, 300, 300, 300, 300]
          : role === "operator"
            ? [400, 200, 140, 400, 200, 140]
            : [480, 220, 260, 440, 240, 160]
    ).map((duration, index) => ({ pixels: pixelsFor(role, index), duration })),
    idle: pixelsFor(role, 0, "idle"),
    answering: pixelsFor(role, 0, "answering"),
}));

/** Standard Unicode half blocks: two vertical pixels per terminal cell. */
export function terminalLines(pixels: string[]): string[] {
    return Array.from({ length: HEIGHT / 2 }, (_, row) =>
        Array.from({ length: WIDTH }, (_, col) => {
            const top = pixels[row * 2][col] === "#";
            const bottom = pixels[row * 2 + 1][col] === "#";
            return top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
        }).join(""),
    );
}

export function svgPath(pixels: string[]): string {
    return pixels
        .flatMap((row, y) => [...row].flatMap((pixel, x) => (pixel === "#" ? [`M${x} ${y}h1v1h-1z`] : [])))
        .join("");
}
