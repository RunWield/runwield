import type {
    UsageDestination,
    UsageSettingsRequest,
    UsageSettingsResponse,
    UsageSettingsView,
} from "./owner-usage-settings.ts";

let globalEnabled = false;
let exporterState = "approved";
let scaleFixture = false;
const fields = [
    { key: "publicKey", label: "Public key", secret: false },
    { key: "secretKey", label: "Secret key", secret: true },
];
let destinations: UsageDestination[] = [
    {
        destinationId: "dev-langfuse",
        exporterId: "langfuse",
        exporterApproved: true,
        endpoint: "https://cloud.langfuse.com/",
        insecureLocalEndpoint: false,
        externalProject: "Personal workspace",
        projects: [{ projectId: "dev-project", label: "RunWield" }],
        unavailableProjectCount: 1,
        credentials: { configured: true },
        credentialFields: fields,
        counts: { pending: 3, accepted: 12, confirmed: 10, unconfirmed: 1, rejected: 2 },
        latestCodes: ["http_200", "process_lost", "http_401"],
        lastAttemptAt: "2026-09-21T18:20:00Z",
    },
];

export function devUsageSettings(state?: string | null): UsageSettingsView {
    if (state === "scale" && !scaleFixture) {
        scaleFixture = true;
        exporterState = "approved";
        destinations.push({
            exporterApproved: true,
            insecureLocalEndpoint: false,
            destinationId: "dev-archive",
            exporterId: "usage-archive",
            endpoint: "https://metrics.example.com/",
            externalProject: "Engineering archive",
            projects: [],
            unavailableProjectCount: 0,
            credentials: { configured: false },
            credentialFields: [],
            counts: { pending: 0, accepted: 0, confirmed: 0, unconfirmed: 0, rejected: 0 },
            latestCodes: [],
            lastAttemptAt: null,
        });
    }
    if (state && ["none", "installed_unapproved", "approved"].includes(state)) exporterState = state;
    return {
        exportAvailable: true,
        unavailableReason: null,
        exporters:
            exporterState === "none"
                ? []
                : [
                      {
                          exporterKey: "dev-langfuse-exporter",
                          id: "langfuse",
                          version: "0.1.0",
                          state: exporterState === "approved" ? "approved" : "installed_unapproved",
                          credentialFields: fields,
                      },
                      ...(scaleFixture
                          ? [
                                {
                                    exporterKey: "dev-archive-exporter",
                                    id: "usage-archive",
                                    version: "1.0.0",
                                    state: "approved" as const,
                                    credentialFields: [],
                                },
                            ]
                          : []),
                  ],
        destinations: structuredClone(
            destinations.map((destination) => ({ ...destination, exporterApproved: exporterState === "approved" })),
        ),
        recording: {
            globalEnabled,
            projects: [
                { projectId: "dev-project", label: "RunWield", enabled: globalEnabled, setBy: "global" },
                { projectId: "dev-project-b", label: "Notes", enabled: false, setBy: "project" },
                ...(scaleFixture
                    ? Array.from({ length: 78 }, (_, index) => ({
                          projectId: `dev-scale-${index + 1}`,
                          label:
                              index === 77
                                  ? "Payments platform with a long Project name for shared reporting"
                                  : `Service ${String(index + 1).padStart(2, "0")}`,
                          enabled: globalEnabled,
                          setBy: "global" as const,
                      }))
                    : []),
            ],
        },
    };
}

export function devMutateUsageSettings(action: string, body: UsageSettingsRequest): UsageSettingsResponse {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid request body.");
    const result: NonNullable<UsageSettingsResponse["result"]> = {};
    if (action === "recording") {
        if (typeof body.enabled !== "boolean") throw new Error("Choose recording on or off.");
        globalEnabled = body.enabled;
    } else if (action === "clear") {
        if (!body.confirmed || !body.projectIds?.length)
            throw new Error("Confirm clearing history and choose at least one Project.");
        result.cleared = body.projectIds.map((projectId) => ({
            projectId,
            cleared: true,
            reason: null,
            deliveryInFlight: true,
        }));
        result.deliveryInFlight = true;
        destinations = destinations.map((destination) => ({
            ...destination,
            counts: { pending: 0, accepted: 0, confirmed: 0, unconfirmed: 0, rejected: 0 },
        }));
    } else if (action === "create" || action === "destination") {
        if (exporterState !== "approved") throw new Error("Choose an installed, approved exporter.");
        const endpoint = new URL(body.endpoint || "");
        if (
            endpoint.protocol !== "https:" &&
            !(
                endpoint.protocol === "http:" &&
                ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) &&
                body.allowInsecureLocalEndpoint
            )
        ) {
            throw new Error("Export endpoint requires HTTPS, or explicit loopback HTTP permission");
        }
        const previous = destinations.find((destination) => destination.destinationId === body.destinationId);
        if (action === "destination" && (!previous || body.confirmed !== true))
            throw new Error("Confirm the destination change before saving.");
        const exporter = devUsageSettings().exporters.find((entry) =>
            previous ? entry.id === previous.exporterId : entry.exporterKey === body.exporterKey,
        );
        if (!exporter) throw new Error("Choose an installed, approved exporter.");
        const next: UsageDestination = {
            destinationId: previous?.destinationId || crypto.randomUUID(),
            exporterId: exporter.id,
            exporterApproved: true,
            endpoint: endpoint.href,
            insecureLocalEndpoint: endpoint.protocol === "http:",
            externalProject: body.externalProject || "",
            projects: devUsageSettings()
                .recording.projects.filter((project) => body.projectIds?.includes(project.projectId))
                .map(({ projectId, label }) => ({ projectId, label })),
            unavailableProjectCount: previous?.unavailableProjectCount || 0,
            credentials: {
                configured: previous?.credentials.configured || Object.values(body.credentials || {}).some(Boolean),
            },
            credentialFields: exporter.credentialFields,
            counts: { pending: 0, accepted: 0, confirmed: 0, unconfirmed: 0, rejected: 0 },
            latestCodes: [],
            lastAttemptAt: null,
        };
        result.newBoundary = !!previous;
        destinations = [
            ...destinations.filter((destination) => destination.destinationId !== next.destinationId),
            next,
        ];
    } else {
        const destination = destinations.find((entry) => entry.destinationId === body.destinationId);
        if (!destination) throw new Error("Choose an existing destination.");
        if (action === "revoke") {
            if (!body.confirmed) throw new Error("Confirm revoking this destination.");
            destinations = destinations.filter((entry) => entry !== destination);
            result.deliveryInFlight = true;
        } else if (action === "projects") {
            destination.projects = devUsageSettings()
                .recording.projects.filter((project) => body.projectIds?.includes(project.projectId))
                .map(({ projectId, label }) => ({ projectId, label }));
        } else if (action === "credentials") {
            destination.credentials = {
                configured: !body.clearCredentials && Object.values(body.credentials || {}).some(Boolean),
            };
        } else throw new Error("Unknown usage settings action.");
    }
    return { ...devUsageSettings(), result };
}
