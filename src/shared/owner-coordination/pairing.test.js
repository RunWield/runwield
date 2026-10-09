import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { openOwnerCoordinationDatabase } from "./database.js";
import { hashSecret, randomHumanCode } from "./crypto.ts";
import {
    approvePairingRequest,
    claimPairingRequest,
    createPairingRequest,
    getPairingRequestByProof,
    stripTerminalControlCharacters,
} from "./pairing.js";
import { listDevices, revokeDevice, verifyDeviceCredential, verifyDeviceCsrf } from "./devices.ts";

/** @returns {() => string} */
function idFactory() {
    let next = 0;
    return () => `id-${++next}`;
}

/** @param {any} database @param {string} deviceId */
function getLastSeen(database, deviceId) {
    return String(
        /** @type {any} */ (database.handle.prepare("SELECT last_seen_at FROM paired_devices WHERE id = ?").get(
            deviceId,
        ))
            .last_seen_at,
    );
}

Deno.test("pairing approval codes use cryptographic randomness by default", () => {
    const originalRandom = Math.random;
    try {
        Math.random = () => 0;
        const code = randomHumanCode();
        assertMatch(code, /^[A-Z2-9]{6}$/);
        assertEquals(code === "AAAAAA", false);
    } finally {
        Math.random = originalRandom;
    }
});

Deno.test("pairing request stores only hashes and requires approval before claim", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-pairing-" });
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    try {
        const ids = idFactory();
        const request = createPairingRequest(database, {
            deviceLabel: "Phone",
            idFactory: ids,
            now: () => "2026-01-01T00:00:00.000Z",
            codeFactory: () => "ABC123",
            proofFactory: () => "browser-proof",
        });
        assertEquals(request.code, "ABC123");
        assertEquals(request.proof, "browser-proof");
        assertThrows(() => claimPairingRequest(database, request.proof, { now: () => "2026-01-01T00:00:01.000Z" }));

        const row = /** @type {any} */ (database.handle.prepare(
            "SELECT code_hash, proof_hash FROM pairing_requests WHERE id = ?",
        ).get(
            request.requestId,
        ));
        assertEquals(row.code_hash, hashSecret("ABC123"));
        assertEquals(row.proof_hash, hashSecret("browser-proof"));
        assertEquals(JSON.stringify(row).includes("ABC123"), false);
        assertEquals(JSON.stringify(row).includes("browser-proof"), false);

        const approved = approvePairingRequest(database, "abc-123", { now: () => "2026-01-01T00:00:02.000Z" });
        assertEquals(approved.state, "approved");
        const claimed = claimPairingRequest(database, request.proof, {
            idFactory: ids,
            now: () => "2026-01-01T00:00:03.000Z",
            credentialFactory: () => "credential-secret",
            csrfFactory: () => "csrf-secret",
        });
        assertEquals(claimed.deviceId, "id-2");
        assertEquals(claimed.credential, "credential-secret");
        assertEquals(claimed.csrf, "csrf-secret");
        assertEquals(claimed.request.state, "claimed");
        assertThrows(() => claimPairingRequest(database, request.proof, { now: () => "2026-01-01T00:00:04.000Z" }));
        assertEquals(
            verifyDeviceCredential(database, claimed.credential, { now: () => "2026-01-01T00:00:05.000Z" })?.deviceId,
            claimed.deviceId,
        );
        assertEquals(verifyDeviceCsrf(database, claimed.deviceId, claimed.csrf), true);
    } finally {
        database.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("pairing device labels strip terminal control characters", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-pairing-label-" });
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    try {
        assertEquals(stripTerminalControlCharacters("Phone\x1B[31m\x07"), "Phone");
        const request = createPairingRequest(database, {
            deviceLabel: "Phone\x1B[31m\x07\nName",
            idFactory: idFactory(),
            now: () => "2026-01-01T00:00:00.000Z",
            codeFactory: () => "LABEL1",
            proofFactory: () => "proof",
        });
        const approved = approvePairingRequest(database, request.code, { now: () => "2026-01-01T00:00:01.000Z" });
        assertEquals(approved.deviceLabel, "PhoneName");
    } finally {
        database.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("pairing expiry and pending cap are enforced", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-pairing-expiry-" });
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    try {
        const ids = idFactory();
        const request = createPairingRequest(database, {
            idFactory: ids,
            now: () => "2026-01-01T00:00:00.000Z",
            codeFactory: () => "EXPIRE",
            proofFactory: () => "proof",
            ttlMs: 1000,
        });
        assertEquals(
            getPairingRequestByProof(database, request.proof, { now: () => "2026-01-01T00:00:00.500Z" })?.state,
            "pending",
        );
        assertThrows(
            () => approvePairingRequest(database, request.code, { now: () => "2026-01-01T00:00:02.000Z" }),
            Error,
            "expired",
        );

        createPairingRequest(database, {
            idFactory: ids,
            now: () => "2026-01-01T00:01:00.000Z",
            codeFactory: () => "CAP001",
            proofFactory: () => "cap-proof",
            maxPending: 1,
        });
        assertThrows(
            () =>
                createPairingRequest(database, {
                    idFactory: ids,
                    now: () => "2026-01-01T00:01:01.000Z",
                    codeFactory: () => "CAP002",
                    proofFactory: () => "cap-proof-2",
                    maxPending: 1,
                }),
            Error,
            "Too many pending",
        );
    } finally {
        database.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("pairing code generation skips unpruned claimed requests", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-pairing-claimed-collision-" });
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    try {
        const ids = idFactory();
        const first = createPairingRequest(database, {
            idFactory: ids,
            now: () => "2026-01-01T00:00:00.000Z",
            codeFactory: () => "REUSE1",
            proofFactory: () => "proof-1",
        });
        approvePairingRequest(database, first.code, { now: () => "2026-01-01T00:00:01.000Z" });
        claimPairingRequest(database, first.proof, {
            idFactory: ids,
            now: () => "2026-01-01T00:00:02.000Z",
            credentialFactory: () => "credential-1",
            csrfFactory: () => "csrf-1",
        });

        const codes = ["REUSE1", "NEW222"];
        const second = createPairingRequest(database, {
            idFactory: ids,
            now: () => "2026-01-01T00:01:00.000Z",
            codeFactory: () => codes.shift() || "NEW222",
            proofFactory: () => "proof-2",
        });
        assertEquals(second.code, "NEW222");
        assertEquals(
            approvePairingRequest(database, second.code, { now: () => "2026-01-01T00:01:01.000Z" }).requestId,
            second.requestId,
        );
    } finally {
        database.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("device credentials are revocable and never listed as secrets", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-devices-" });
    const database = openOwnerCoordinationDatabase({ dbPath: `${dir}/owner.sqlite3` });
    try {
        const request = createPairingRequest(database, {
            idFactory: idFactory(),
            now: () => "2026-01-01T00:00:00.000Z",
            codeFactory: () => "DEVICE",
            proofFactory: () => "proof",
        });
        approvePairingRequest(database, request.code, { now: () => "2026-01-01T00:00:01.000Z" });
        const claimed = claimPairingRequest(database, request.proof, {
            idFactory: idFactory(),
            now: () => "2026-01-01T00:00:02.000Z",
            credentialFactory: () => "credential-secret",
            csrfFactory: () => "csrf-secret",
        });
        const devices = listDevices(database);
        assertEquals(devices.length, 1);
        assertEquals(JSON.stringify(devices).includes("credential-secret"), false);
        assertEquals(JSON.stringify(devices).includes("csrf-secret"), false);
        const credentialRow =
            /** @type {any} */ (database.handle.prepare("SELECT credential_hash FROM paired_devices").get());
        assertMatch(String(credentialRow.credential_hash), /^sha256:/);
        assert(verifyDeviceCredential(database, "credential-secret", { now: () => "2026-01-01T00:00:03.000Z" }));
        const firstSeen = getLastSeen(database, claimed.deviceId);
        assertEquals(firstSeen, "2026-01-01T00:00:03.000Z");
        assert(verifyDeviceCredential(database, "credential-secret", { now: () => "2026-01-01T00:00:30.000Z" }));
        assertEquals(getLastSeen(database, claimed.deviceId), firstSeen);
        assert(verifyDeviceCredential(database, "credential-secret", { now: () => "2026-01-01T00:01:04.000Z" }));
        assertEquals(getLastSeen(database, claimed.deviceId), "2026-01-01T00:01:04.000Z");
        revokeDevice(database, claimed.deviceId, { now: () => "2026-01-01T00:02:03.000Z" });
        assertEquals(verifyDeviceCredential(database, "credential-secret"), null);
        assertEquals(verifyDeviceCsrf(database, claimed.deviceId, "csrf-secret"), false);
    } finally {
        database.close();
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("two database connections cannot claim one approved request twice", async () => {
    const dir = await Deno.makeTempDir({ prefix: "runwield-pairing-race-" });
    const dbPath = `${dir}/owner.sqlite3`;
    const first = openOwnerCoordinationDatabase({ dbPath });
    const second = openOwnerCoordinationDatabase({ dbPath });
    try {
        const request = createPairingRequest(first, {
            idFactory: idFactory(),
            now: () => "2026-01-01T00:00:00.000Z",
            codeFactory: () => "RACE01",
            proofFactory: () => "proof",
        });
        approvePairingRequest(second, request.code, { now: () => "2026-01-01T00:00:01.000Z" });
        const claimed = claimPairingRequest(first, request.proof, {
            idFactory: () => "device-1",
            now: () => "2026-01-01T00:00:02.000Z",
            credentialFactory: () => "credential-1",
            csrfFactory: () => "csrf-1",
        });
        assertEquals(claimed.deviceId, "device-1");
        assertThrows(
            () =>
                claimPairingRequest(second, request.proof, {
                    idFactory: () => "device-2",
                    now: () => "2026-01-01T00:00:03.000Z",
                    credentialFactory: () => "credential-2",
                    csrfFactory: () => "csrf-2",
                }),
            Error,
            "already been claimed",
        );
        assertEquals(listDevices(first).length, 1);
    } finally {
        first.close();
        second.close();
        await Deno.remove(dir, { recursive: true });
    }
});
