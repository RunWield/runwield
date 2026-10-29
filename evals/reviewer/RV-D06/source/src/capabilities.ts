import { createHmac, timingSafeEqual } from "node:crypto";
import type { Capability } from "./model.ts";

function signature(key: string, claims: string): Buffer {
    return createHmac("sha256", key).update(claims).digest();
}
export function issueCapability(key: string, capability: Capability): string {
    if (!/^[a-zA-Z0-9-]+$/.test(capability.boardId)) throw new Error("Invalid board identity");
    const claims = `${capability.boardId}.${capability.role}`;
    return `${claims}.${signature(key, claims).toString("base64url")}`;
}
export function verifyCapability(key: string, token: string): Capability {
    const [boardId, role, encodedSignature, ...extra] = token.split(".");
    if (
        !boardId ||
        !/^[a-zA-Z0-9-]+$/.test(boardId) ||
        (role !== "reviewer" && role !== "maintainer") ||
        !encodedSignature ||
        extra.length
    ) {
        throw new Error("Invalid capability");
    }
    const expected = signature(key, `${boardId}.${role}`);
    const received = Buffer.from(encodedSignature, "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected))
        throw new Error("Invalid capability");
    return { boardId, role };
}
