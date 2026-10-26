import type { BoardLink } from "./model.ts";

export function parseBoardLink(href: string): BoardLink {
    const url = new URL(href);
    return {
        boardId: url.searchParams.get("board") ?? "",
        token: url.searchParams.get("cap") ?? "",
        displayRole: url.searchParams.get("role") === "maintainer" ? "maintainer" : "reviewer",
    };
}
