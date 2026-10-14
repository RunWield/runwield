import { basename } from "node:path";
import { createHash } from "node:crypto";
/**
 * @module shared/project-directory-key
 * The filesystem-safe directory segment that keys per-project state under `~/.wld/`.
 *
 * Sessions, execution worktrees, workflow metrics, and Attached Workflow Records all
 * use this one encoding, so a project resolves to the same segment everywhere.
 */

/** Encode cwd into a filesystem-safe directory segment (Pi-style). */
export function encodeCwdForSessionDir(cwd: string): string {
    const encoded = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    if (encoded.length <= 120) return encoded;
    const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 32);
    const readableTail =
        basename(cwd)
            .replace(/[/\\:]/g, "-")
            .slice(0, 40) || "root";
    return `--${readableTail}-${digest}--`;
}
