import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const CHECKOUT = fileURLToPath(new URL("../../../../", import.meta.url));
export const UNAUTHENTICATED_CLAUDE = `
if(process.argv.includes('--version')) console.log('2.1.303 (Claude Code)');
else if(process.argv.includes('auth')) { console.log(JSON.stringify({loggedIn:false})); process.exitCode=1; }
else process.exitCode=0;
`;

/** The only stand-in is the external Claude executable. Core and Git are never replaced. */
export async function withExternalClaude(
    source: string,
    run: (root: string, claude: string) => Promise<void>,
): Promise<void> {
    const parent = await mkdtemp(join(tmpdir(), "connect-acceptance-runtime-"));
    const claude = join(parent, "claude");
    try {
        await writeFile(claude, `#!${process.execPath}\n${source}`, { mode: 0o755 });
        await run(join(parent, "evidence"), claude);
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
}
