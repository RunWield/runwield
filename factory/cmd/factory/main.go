package main

import (
	"fmt"
	factory "github.com/runwield/runwield/factory/internal/runtime"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	kruntime "k8s.io/apimachinery/pkg/runtime"
	"os"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
)

func run() error {
	ctrl.SetLogger(zap.New())
	namespace := os.Getenv("FACTORY_NAMESPACE")
	if namespace == "" {
		return fmt.Errorf("FACTORY_NAMESPACE is required")
	}
	scheme := kruntime.NewScheme()
	for _, add := range []func(*kruntime.Scheme) error{factory.AddToScheme, corev1.AddToScheme, batchv1.AddToScheme, rbacv1.AddToScheme} {
		if err := add(scheme); err != nil {
			return err
		}
	}
	config, err := ctrl.GetConfig()
	if err != nil {
		return err
	}
	direct, err := client.New(config, client.Options{Scheme: scheme})
	if err != nil {
		return err
	}
	ctx := ctrl.SetupSignalHandler()
	if len(os.Args) > 1 && os.Args[1] == "worker" {
		return factory.RunWorker(ctx, direct, namespace, os.Getenv("FACTORY_EXECUTION"))
	}
	if len(os.Args) > 1 && os.Args[1] == "wake" {
		return factory.AdmitWake(ctx, direct, namespace, os.Getenv("FACTORY_WAKE_JOB"), "/recipe/recipe.json")
	}
	image := os.Getenv("FACTORY_WORKER_IMAGE")
	if image == "" {
		return fmt.Errorf("FACTORY_WORKER_IMAGE is required")
	}
	secret := os.Getenv("FACTORY_CREDENTIAL_SECRET")
	if secret == "" {
		return fmt.Errorf("FACTORY_CREDENTIAL_SECRET is required")
	}
	manager, err := ctrl.NewManager(config, ctrl.Options{Scheme: scheme, Cache: cache.Options{DefaultNamespaces: map[string]cache.Config{namespace: {}}}, LeaderElection: true, LeaderElectionID: "runwield-factory", LeaderElectionNamespace: namespace, Metrics: metricsserver.Options{BindAddress: "0"}})
	if err != nil {
		return err
	}
	controller := &factory.Controller{Client: direct, Scheme: scheme, Image: image, CredentialSecret: secret, GitHubSecret: os.Getenv("FACTORY_GITHUB_SECRET")}
	if err := ctrl.NewControllerManagedBy(manager).For(&factory.FactoryRun{}).Owns(&factory.StepExecution{}).Owns(&batchv1.Job{}).Complete(controller); err != nil {
		return err
	}
	if os.Getenv("FACTORY_GITHUB_SECRET") != "" {
		intake := &factory.TriageController{Client: direct, GitHub: factory.NewGitHub("/github/token")}
		if err := ctrl.NewControllerManagedBy(manager).For(&factory.GitHubTriage{}).Complete(intake); err != nil {
			return err
		}
	}
	return manager.Start(ctx)
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
