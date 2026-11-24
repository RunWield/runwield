/** Opinionated Router recipes. Intake is Kubernetes-owned; publication stays in wld. */
export interface GitHubRecipeConfig {
    namespace: string;
    projectId: string;
    repository: string;
    repositoryId: string;
    model: string;
    image: string;
    schedule: string;
    batchName: string;
}

export function githubTriageRecipes(config: GitHubRecipeConfig) {
    const apiVersion = "factory.runwield.dev/v1alpha1";
    const name = "github-test-triage";
    const metadata = { name, namespace: config.namespace };
    const spec = {
        projectId: config.projectId,
        repository: config.repository,
        repositoryId: config.repositoryId,
        label: "test",
        excludeLabels: ["status:in-progress"],
        model: config.model,
    };
    return {
        apiVersion: "v1",
        kind: "List",
        items: [
            {
                apiVersion,
                kind: "GitHubTriage",
                metadata: { name: config.batchName, namespace: config.namespace },
                spec: { ...spec, mode: "batch" },
            },
            { apiVersion: "v1", kind: "ServiceAccount", metadata },
            {
                apiVersion: "rbac.authorization.k8s.io/v1",
                kind: "Role",
                metadata,
                rules: [
                    { apiGroups: ["factory.runwield.dev"], resources: ["githubtriages"], verbs: ["create", "get"] },
                ],
            },
            {
                apiVersion: "rbac.authorization.k8s.io/v1",
                kind: "RoleBinding",
                metadata,
                roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name },
                subjects: [{ kind: "ServiceAccount", name, namespace: config.namespace }],
            },
            {
                apiVersion: "v1",
                kind: "ConfigMap",
                metadata,
                data: { "recipe.json": JSON.stringify({ ...spec, mode: "next" }) },
            },
            {
                apiVersion: "batch/v1",
                kind: "CronJob",
                metadata,
                spec: {
                    schedule: config.schedule,
                    timeZone: "Etc/UTC",
                    concurrencyPolicy: "Forbid",
                    startingDeadlineSeconds: 300,
                    successfulJobsHistoryLimit: 2,
                    failedJobsHistoryLimit: 2,
                    jobTemplate: {
                        spec: {
                            backoffLimit: 3,
                            activeDeadlineSeconds: 300,
                            template: {
                                spec: {
                                    serviceAccountName: name,
                                    restartPolicy: "Never",
                                    securityContext: {
                                        runAsNonRoot: true,
                                        runAsUser: 1000,
                                        runAsGroup: 1000,
                                        seccompProfile: { type: "RuntimeDefault" },
                                    },
                                    containers: [
                                        {
                                            name: "wake",
                                            image: config.image,
                                            imagePullPolicy: "IfNotPresent",
                                            args: ["wake"],
                                            env: [
                                                { name: "FACTORY_NAMESPACE", value: config.namespace },
                                                {
                                                    name: "FACTORY_WAKE_JOB",
                                                    valueFrom: {
                                                        fieldRef: {
                                                            fieldPath:
                                                                "metadata.labels['batch.kubernetes.io/job-name']",
                                                        },
                                                    },
                                                },
                                            ],
                                            securityContext: {
                                                allowPrivilegeEscalation: false,
                                                readOnlyRootFilesystem: true,
                                                capabilities: { drop: ["ALL"] },
                                            },
                                            resources: {
                                                requests: { cpu: "10m", memory: "32Mi" },
                                                limits: { cpu: "200m", memory: "128Mi" },
                                            },
                                            volumeMounts: [{ name: "recipe", mountPath: "/recipe", readOnly: true }],
                                        },
                                    ],
                                    volumes: [{ name: "recipe", configMap: { name } }],
                                },
                            },
                        },
                    },
                },
            },
        ],
    };
}
