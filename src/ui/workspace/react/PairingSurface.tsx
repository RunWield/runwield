import { RunWieldThinkingDots } from "../../design-system/components/react/RunWieldPrimitives.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { RunWieldButton } from "../../design-system/components/react/RunWieldPrimitives.tsx";

type PairingState = "idle" | "loading" | "pending" | "approved" | "paired" | "expired" | "missing" | "error";

interface PairingResponse {
    code?: string;
    error?: string;
    expiresAt?: string;
    state: PairingState;
}

function defaultDeviceLabel() {
    const ua = navigator.userAgent;
    const browser = ua.includes("Edg/")
        ? "Edge"
        : ua.includes("CriOS") || ua.includes("Chrome/")
        ? "Chrome"
        : ua.includes("Firefox/") || ua.includes("FxiOS")
        ? "Firefox"
        : ua.includes("Safari/")
        ? "Safari"
        : "Browser";
    const os = /iPhone|iPad|iPod/.test(ua)
        ? "iPhone"
        : ua.includes("Android")
        ? "Android"
        : ua.includes("Mac OS X")
        ? "macOS"
        : ua.includes("Windows")
        ? "Windows"
        : ua.includes("Linux")
        ? "Linux"
        : "this device";
    return `${browser} on ${os}`;
}

async function copyText(value: string) {
    try {
        await navigator.clipboard.writeText(value);
    } catch {
        throw new Error("Copy is unavailable in this browser. Select the command and copy it manually.");
    }
}

export function PairingSurface() {
    const [deviceLabel, setDeviceLabel] = useState("Browser device");
    const [code, setCode] = useState("------");
    const [expiresAt, setExpiresAt] = useState(0);
    const [remaining, setRemaining] = useState(0);
    const [state, setState] = useState<PairingState>("idle");
    const [message, setMessage] = useState("");
    const [copied, setCopied] = useState(false);
    const requestVersion = useRef(0);

    const requestCode = useCallback(async (label: string) => {
        const version = ++requestVersion.current;
        setState("loading");
        setMessage("");
        try {
            // A restored pairing page may already have a valid device cookie,
            // even when the initial app navigation omitted a legacy Strict cookie.
            const status = await fetch("/api/owner/pairing/status", { cache: "no-store" });
            const existing: PairingResponse = await status.json();
            if (version !== requestVersion.current) return;
            if (status.ok && existing.state === "paired") {
                globalThis.location.replace("/");
                return;
            }
            const response = await fetch("/api/owner/pairing/request", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ deviceLabel: label }),
            });
            const payload: PairingResponse = await response.json();
            if (version !== requestVersion.current) return;
            if (!response.ok || !payload.code || !payload.expiresAt) {
                setState("error");
                setMessage(payload.error || "RunWield could not create a pairing code.");
                return;
            }
            const expiry = new Date(payload.expiresAt).getTime();
            setCode(payload.code);
            setExpiresAt(expiry);
            setRemaining(Math.max(0, expiry - Date.now()));
            setState("pending");
        } catch (caught) {
            if (version !== requestVersion.current) return;
            setState("error");
            setMessage(caught instanceof Error ? caught.message : String(caught));
        }
    }, []);

    useEffect(() => {
        const label = defaultDeviceLabel();
        setDeviceLabel(label);
        void requestCode(label);
    }, [requestCode]);

    useEffect(() => {
        if (state !== "pending" || !expiresAt) return;
        const timer = globalThis.setInterval(() => setRemaining(Math.max(0, expiresAt - Date.now())), 1000);
        return () => globalThis.clearInterval(timer);
    }, [expiresAt, state]);

    useEffect(() => {
        if (state === "pending" && remaining <= 0) void requestCode(deviceLabel);
    }, [deviceLabel, remaining, requestCode, state]);

    useEffect(() => {
        if (state !== "pending") return;
        let cancelled = false;
        async function poll() {
            try {
                const response = await fetch("/api/owner/pairing/status", { cache: "no-store" });
                const payload: PairingResponse = await response.json();
                if (cancelled) return;
                if (payload.state === "paired") {
                    globalThis.location.replace("/");
                    return;
                }
                if (payload.state === "approved") {
                    setState("approved");
                    const claim = await fetch("/api/owner/pairing/claim", { method: "POST" });
                    if (claim.ok) globalThis.location.assign("/");
                    else {
                        const claimPayload: PairingResponse = await claim.json();
                        setState("error");
                        setMessage(claimPayload.error || "The approved browser could not be paired.");
                    }
                    return;
                }
                if (payload.state === "expired" || payload.state === "missing") {
                    void requestCode(deviceLabel);
                }
            } catch (caught) {
                if (!cancelled) setMessage(caught instanceof Error ? caught.message : String(caught));
            }
        }
        const timer = globalThis.setInterval(() => void poll(), 1500);
        return () => {
            cancelled = true;
            globalThis.clearInterval(timer);
        };
    }, [deviceLabel, requestCode, state]);

    const seconds = Math.ceil(remaining / 1000);
    const timerLabel = state === "loading"
        ? "Generating a secure pairing code…"
        : state === "approved"
        ? "Approved. Finishing browser authorization…"
        : state === "pending"
        ? `This code expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.`
        : "Pairing is waiting to restart.";
    const command = `wld workspace pair ${code}`;

    return (
        <section className="pairing-card pairing-surface">
            <header className="pairing-header">
                <p className="kicker">Device pairing</p>
                <h1>Authorize this browser</h1>
                <p>Approve one short-lived code from the machine running RunWield.</p>
            </header>
            <div className="pairing-panel">
                <form className="owner-form pairing-device-form" onSubmit={(event) => event.preventDefault()}>
                    <label>
                        Device label
                        <input
                            name="deviceLabel"
                            value={deviceLabel}
                            maxLength={80}
                            onChange={(event) => setDeviceLabel(event.currentTarget.value)}
                            onBlur={() => void requestCode(deviceLabel)}
                        />
                    </label>
                </form>
                <div className="owner-pairing-result" aria-live="polite">
                    <p className="pairing-step-label">1 · Copy this code</p>
                    <div className="pairing-code" aria-label="Pairing code">{code}</div>
                    <p className="pairing-timer">
                        {state === "loading" || state === "approved"
                            ? <RunWieldThinkingDots label={timerLabel} />
                            : timerLabel}
                    </p>
                    {message ? <p className="notice danger" role="alert">{message}</p> : null}
                </div>
                <div className="pairing-command-box">
                    <div>
                        <p className="pairing-step-label">2 · Run locally</p>
                        <code>{command}</code>
                    </div>
                    <RunWieldButton
                        variant="primary"
                        className="copy-command-button"
                        disabled={state !== "pending"}
                        onClick={async () => {
                            try {
                                await copyText(command);
                                setCopied(true);
                                globalThis.setTimeout(() => setCopied(false), 1600);
                            } catch (caught) {
                                setMessage(caught instanceof Error ? caught.message : String(caught));
                            }
                        }}
                    >
                        {copied ? "Copied" : "Copy command"}
                    </RunWieldButton>
                </div>
            </div>
        </section>
    );
}

export default PairingSurface;
