/** @module ui/workspace/server/owner-auth */

import {
    OWNER_CSRF_COOKIE,
    OWNER_DEVICE_COOKIE,
    OWNER_DEVICE_MAX_AGE_SECONDS,
} from "../../../shared/owner-coordination/index.js";
import type { OwnerCoordinationStore } from "../../../shared/owner-coordination/index.js";
import type { OwnerConnectionRegistry, OwnerLiveConnection } from "./owner-connections.ts";
import type { OwnerOriginPolicy } from "./owner-origin.ts";
import { assertOwnerOrigin, isStateChangingRequest, parseOwnerOrigin } from "./owner-origin.ts";

export type OwnerCookieOrigin = Pick<OwnerOriginPolicy, "publicOrigin">;

export interface DeviceCookieOptions extends OwnerCookieOrigin {
    credential: string;
    csrf: string;
}

export interface OwnerCookieState extends OwnerCookieOrigin {
    store: Pick<OwnerCoordinationStore, "verifyDeviceCredential" | "verifyDeviceCsrf">;
}

export interface OwnerUpgradeState extends OwnerCookieState {
    ownerConnections?: Partial<Pick<OwnerConnectionRegistry, "register">>;
}

function cookieValue(value: string) {
    return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function parseCookies(cookieHeader: string) {
    const cookies = new Map<string, string>();
    for (const part of String(cookieHeader || "").split(";")) {
        const index = part.indexOf("=");
        if (index < 0) continue;
        cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
    }
    return cookies;
}

export function getCookie(request: Request, name: string) {
    return parseCookies(request.headers.get("cookie") || "").get(name) || "";
}

export function deviceCookieHeaders(options: DeviceCookieOptions) {
    const secure = parseOwnerOrigin(options.publicOrigin).protocol === "https:";
    const suffix = `Max-Age=${OWNER_DEVICE_MAX_AGE_SECONDS}; Path=/${secure ? "; Secure" : ""}`;
    return [
        `${OWNER_DEVICE_COOKIE}=${cookieValue(options.credential)}; ${suffix}; SameSite=Lax; HttpOnly`,
        `${OWNER_CSRF_COOKIE}=${cookieValue(options.csrf)}; ${suffix}; SameSite=Strict`,
    ];
}

/**
 * Renew existing pairing on document visits, including credentials issued before
 * app-launch cookies used SameSite=Lax. Keep credentials out of browser storage.
 */
export function renewDeviceCookies(request: Request, response: Response, state: OwnerCookieState, deviceId: string) {
    const csrf = getCookie(request, OWNER_CSRF_COOKIE);
    if (!csrf || !state.store.verifyDeviceCsrf(deviceId, csrf)) return response;
    const headers = new Headers(response.headers);
    for (
        const cookie of deviceCookieHeaders({
            credential: getCookie(request, OWNER_DEVICE_COOKIE),
            csrf,
            publicOrigin: state.publicOrigin,
        })
    ) headers.append("set-cookie", cookie);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function clearDeviceCookieHeaders(options: OwnerCookieOrigin) {
    const secure = parseOwnerOrigin(options.publicOrigin).protocol === "https:";
    const suffix = `Max-Age=0; Path=/; SameSite=Strict${secure ? "; Secure" : ""}`;
    return [
        `${OWNER_DEVICE_COOKIE}=; ${suffix}; HttpOnly`,
        `${OWNER_CSRF_COOKIE}=; ${suffix}`,
    ];
}

export function bootstrapProofCookieHeader(proof: string, options: OwnerCookieOrigin) {
    const secure = parseOwnerOrigin(options.publicOrigin).protocol === "https:";
    return `rw_pairing_proof=${cookieValue(proof)}; Max-Age=300; Path=/; SameSite=Strict${
        secure ? "; Secure" : ""
    }; HttpOnly`;
}

export function clearBootstrapProofCookieHeader(options: OwnerCookieOrigin) {
    const secure = parseOwnerOrigin(options.publicOrigin).protocol === "https:";
    return `rw_pairing_proof=; Max-Age=0; Path=/; SameSite=Strict${secure ? "; Secure" : ""}; HttpOnly`;
}

export function authenticateOwnerRequest(request: Request, state: OwnerCookieState) {
    const credential = getCookie(request, OWNER_DEVICE_COOKIE);
    const device = credential ? state.store.verifyDeviceCredential(credential) : null;
    if (!device) return null;
    if (isStateChangingRequest(request)) {
        assertOwnerOrigin(request, { publicOrigin: state.publicOrigin });
        const csrfCookie = getCookie(request, OWNER_CSRF_COOKIE);
        const csrfHeader = request.headers.get("x-runwield-csrf") || "";
        if (!csrfCookie || csrfCookie !== csrfHeader || !state.store.verifyDeviceCsrf(device.deviceId, csrfCookie)) {
            throw new Error("Owner Workspace CSRF check failed.");
        }
    }
    return device;
}

export function isOwnerUpgradeRequest(request: Request) {
    return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * Authorize a future owner WebSocket upgrade using the same trusted device cookie
 * as HTTP APIs plus an exact Origin check. CSRF headers are unavailable on
 * browser WebSocket handshakes, so Origin is the CSRF-equivalent browser proof.
 */
export function authorizeOwnerUpgradeRequest(
    request: Request,
    state: OwnerUpgradeState,
    connection?: OwnerLiveConnection,
) {
    if (!isOwnerUpgradeRequest(request)) throw new Error("Owner Workspace upgrade request is required.");
    assertOwnerOrigin(request, { publicOrigin: state.publicOrigin });
    const credential = getCookie(request, OWNER_DEVICE_COOKIE);
    const device = credential ? state.store.verifyDeviceCredential(credential) : null;
    if (!device) throw new Error("Owner Workspace device pairing required.");
    const unregister = connection ? state.ownerConnections?.register?.(device.deviceId, connection) : undefined;
    return { ...device, unregister };
}
