export type Role = "reviewer" | "maintainer";
export interface Capability {
    boardId: string;
    role: Role;
}
export interface Board {
    id: string;
    title: string;
}
export interface BoardLink {
    boardId: string;
    token: string;
    displayRole: Role;
}
export interface LinkResult {
    status: 200 | 403;
    displayRole: Role;
    board?: Board;
}
