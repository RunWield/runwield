/** Network boundary guard for a disposable fixture subprocess. */
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import process from "node:process";

export function denyNetwork(): void {
    function denied(): never {
        process.exitCode = 91;
        throw new Error("Isolation fixture forbids network access");
    }
    Reflect.set(globalThis, "fetch", Object.assign(denied, { preconnect: denied }));
    net.Socket.prototype.connect = denied;
    net.Server.prototype.listen = denied;
    tls.connect = denied;
    http.request = http.get = denied;
    https.request = https.get = denied;
    dgram.createSocket = denied;
    Reflect.set(Bun, "connect", denied);
    Reflect.set(Bun, "listen", denied);
    syncBuiltinESMExports();
}
