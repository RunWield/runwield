import { createHash } from "node:crypto";
import { basename } from "node:path";

/** Encode cwd into the existing filesystem-safe Session directory format. */
export function encodeCwdForSessionDir(cwd: string): string {
    const encoded = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    if (encoded.length <= 120) return encoded;
    const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 32);
    const readableTail = basename(cwd).replace(/[/\\:]/g, "-").slice(0, 40) || "root";
    return `--${readableTail}-${digest}--`;
}
