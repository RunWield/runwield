import { verifyCapability } from "./capabilities.ts";
import { parseBoardLink } from "./links.ts";
import { readBoard } from "./boards.ts";
import type { LinkResult } from "./model.ts";

export async function handleBoardLink(root: string, key: string, href: string): Promise<LinkResult> {
    const link = parseBoardLink(href);
    const capability = verifyCapability(key, link.token);
    if (capability.boardId !== link.boardId) return { status: 403, displayRole: link.displayRole };
    return { status: 200, displayRole: link.displayRole, board: await readBoard(root, link.boardId) };
}
