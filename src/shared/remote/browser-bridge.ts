import { SYSTEM_BROWSER_PORT, type BrowserPort } from "../browser-port.ts";
import type { RemoteSessionControlConnection } from "./session-control-client.ts";

import dns from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const nonpublic = new BlockList();
for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3],
] as const)
    nonpublic.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
] as const)
    nonpublic.addSubnet(address, prefix, "ipv6");

function publicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) return !nonpublic.check(address, "ipv4");
    return family === 6 && globalV6.check(address, "ipv6") && !nonpublic.check(address, "ipv6");
}

/** Resolve on the laptop; an unknown or partly private destination is not public. */
async function permittedUrl(value: string, origin: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
        if (url.origin === origin) return true;
        const host = url.hostname
            .toLowerCase()
            .replace(/\.$/, "")
            .replace(/^\[|\]$/g, "");
        if (isIP(host)) return publicAddress(host);
        if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || !host.includes("."))
            return false;
        const addresses = await Promise.race([
            dns.lookup(host, { all: true, verbatim: true }),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Browser DNS resolution timed out")), 2_000);
            }),
        ]);
        return addresses.length > 0 && addresses.every(({ address }) => publicAddress(address));
    } catch {
        return false;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Authentication and readiness are owned by the control service. */
export async function handleBrowserOpen(request: Request, origin: string, ready: () => boolean): Promise<Response> {
    if (!ready()) return new Response(null, { status: 403 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    try {
        const body = await request.text();
        if (body.length > 16_384) return new Response(null, { status: 413 });
        const input = JSON.parse(body);
        if (typeof input?.url !== "string" || !(await permittedUrl(input.url, origin)))
            return new Response(null, { status: 400 });
        if (!ready()) return new Response(null, { status: 403 });
        return Response.json({ opened: await SYSTEM_BROWSER_PORT.open(input.url) });
    } catch {
        return new Response(null, { status: 400 });
    }
}

/** The remote process asks the laptop to open links. Failure leaves the printed URL usable. */
export function createRemoteBrowserPort(connection: RemoteSessionControlConnection): BrowserPort {
    return {
        async open(url) {
            try {
                const response = await fetch(`http://127.0.0.1:${connection.port}/browser/open`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${connection.credential}`, "content-type": "application/json" },
                    body: JSON.stringify({ url }),
                    redirect: "error",
                    signal: AbortSignal.timeout(5_000),
                });
                if (!response.ok) return false;
                const result = await response.json();
                return result?.opened === true;
            } catch {
                return false;
            }
        },
    };
}
