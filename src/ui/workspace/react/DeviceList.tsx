import { RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { useCallback, useEffect, useState } from "react";
import { RunWieldButton } from "../../design-system/components/react/RunWieldPrimitives.tsx";

interface OwnerDevice {
    createdAt: string;
    deviceId: string;
    label: string;
    lastSeenAt: string;
    revokedAt: string | null;
}

interface DeviceListResponse {
    currentDeviceId: string | null;
    devices: OwnerDevice[];
    error?: string;
}

interface DeviceMutationResponse {
    error?: string;
}

function cookieValue(name: string) {
    return document.cookie.split("; ").find((value) => value.startsWith(`${name}=`))?.split("=").slice(1).join("=") ||
        "";
}

function displayTime(value: string) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(parsed);
}

export function DeviceList() {
    const [payload, setPayload] = useState<DeviceListResponse>({ devices: [], currentDeviceId: null });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [revoking, setRevoking] = useState("");

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const response = await fetch("/api/owner/devices", { cache: "no-store" });
            const next: DeviceListResponse = await response.json();
            if (!response.ok) throw new Error(next.error || "Paired devices could not be loaded.");
            setPayload(next);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    async function revoke(device: OwnerDevice) {
        const current = device.deviceId === payload.currentDeviceId;
        if (
            !globalThis.confirm(
                current ? "Revoke this browser? You will need to pair it again." : `Revoke ${device.label}?`,
            )
        ) return;
        setRevoking(device.deviceId);
        setError("");
        try {
            const response = await fetch(`/api/owner/devices/${encodeURIComponent(device.deviceId)}/revoke`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-runwield-csrf": decodeURIComponent(cookieValue("rw_owner_csrf")),
                },
                body: JSON.stringify({ reason: "revoked from Workspace" }),
            });
            const result: DeviceMutationResponse = await response.json();
            if (!response.ok) throw new Error(result.error || "The device could not be revoked.");
            if (current) globalThis.location.assign("/pair");
            else await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setRevoking("");
        }
    }

    if (loading) {
        return (
            <section className="owner-card" aria-busy="true">
                <p>
                    <RunWieldThinkingDots label="Loading paired devices" />
                </p>
            </section>
        );
    }
    if (error && !payload.devices.length) {
        return (
            <section className="error-panel" role="alert">
                <h2>Paired devices failed to load</h2>
                <p>{error}</p>
                <RunWieldButton onClick={() => void load()}>Retry</RunWieldButton>
            </section>
        );
    }
    const activeDevices = payload.devices.filter((device) => !device.revokedAt);
    return (
        <>
            {error ? <p className="notice danger" role="alert">{error}</p> : null}
            <section className="workspace-device-list" aria-label="Paired devices">
                {activeDevices.length
                    ? activeDevices.map((device) => (
                        <article className="owner-card workspace-device-card" key={device.deviceId}>
                            <div className="workspace-device-info">
                                <div className="workspace-device-title">
                                    <h2>{device.label}</h2>
                                    {device.deviceId === payload.currentDeviceId
                                        ? <span className="badge">Current</span>
                                        : null}
                                </div>
                                <p>
                                    Paired {displayTime(device.createdAt)} · Last seen {displayTime(device.lastSeenAt)}
                                </p>
                            </div>
                            <RunWieldButton
                                variant="danger"
                                disabled={revoking === device.deviceId}
                                onClick={() =>
                                    void revoke(device)}
                            >
                                {revoking === device.deviceId ? <RunWieldThinkingDots label="Revoking" /> : "Revoke"}
                            </RunWieldButton>
                        </article>
                    ))
                    : <p className="empty">No paired devices.</p>}
            </section>
        </>
    );
}

export default DeviceList;
