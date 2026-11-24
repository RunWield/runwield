package runtime

import (
	"context"
	"testing"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	kruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func fixture(t *testing.T) (*Controller, *FactoryRun) {
	t.Helper()
	scheme := kruntime.NewScheme()
	for _, add := range []func(*kruntime.Scheme) error{AddToScheme, corev1.AddToScheme, batchv1.AddToScheme, rbacv1.AddToScheme} {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	run := &FactoryRun{ObjectMeta: metav1.ObjectMeta{Name: "example", Namespace: "tenant", UID: types.UID("12345678-1234-1234-1234-123456789abc")}, Spec: RunSpec{ProjectID: "project-id", Loop: "router", Input: Input{Prompt: "Explain pods"}}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&FactoryRun{}, &StepExecution{}, &batchv1.Job{}).WithObjects(run, bindingForTest(run.Namespace, run.Spec.ProjectID)).Build()
	return &Controller{Client: c, Scheme: scheme, Image: "factory:test", CredentialSecret: "model-auth"}, run
}
func reconcile(t *testing.T, c *Controller, run *FactoryRun) {
	t.Helper()
	if _, err := c.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(run)}); err != nil {
		t.Fatal(err)
	}
}
func TestRepeatedReconcileAndRecoveryPreserveOperation(t *testing.T) {
	c, run := fixture(t)
	ctx := context.Background()
	reconcile(t, c, run)
	reconcile(t, c, run)
	var jobs batchv1.JobList
	if err := c.List(ctx, &jobs); err != nil {
		t.Fatal(err)
	}
	if len(jobs.Items) != 1 {
		t.Fatalf("got %d jobs", len(jobs.Items))
	}
	var step StepExecution
	key := types.NamespacedName{Namespace: run.Namespace, Name: executionName(run)}
	if err := c.Get(ctx, key, &step); err != nil {
		t.Fatal(err)
	}
	operation := step.Spec.OperationID
	stepVersion := step.ResourceVersion
	var pvc corev1.PersistentVolumeClaim
	if err := c.Get(ctx, key, &pvc); err != nil {
		t.Fatal(err)
	}
	pvcVersion := pvc.ResourceVersion
	binding := bindingForTest(run.Namespace, run.Spec.ProjectID)
	if err := c.Delete(ctx, binding); err != nil {
		t.Fatal(err)
	}
	if err := c.Delete(ctx, &jobs.Items[0]); err != nil {
		t.Fatal(err)
	}
	result, err := c.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(run)})
	if err != nil || result.RequeueAfter <= 0 {
		t.Fatalf("expected the run to wait for its Project binding: %+v, %v", result, err)
	}
	if err := c.Get(ctx, client.ObjectKeyFromObject(run), run); err != nil || run.Status.Phase != "Running" {
		t.Fatalf("expected the admitted run to retain its claim: %s, %v", run.Status.Phase, err)
	}
	if err := c.Get(ctx, key, &batchv1.Job{}); !apierrors.IsNotFound(err) {
		t.Fatalf("worker recreated without its Project binding: %v", err)
	}
	// Recreate the worker with precisely the same operation and PVC after the binding returns.
	if err := c.Create(ctx, binding); err != nil {
		t.Fatal(err)
	}
	reconcile(t, c, run)
	if err := c.Get(ctx, key, &batchv1.Job{}); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(ctx, key, &step); err != nil {
		t.Fatal(err)
	}
	if operation != step.Spec.OperationID || stepVersion != step.ResourceVersion {
		t.Fatal("execution changed on retry")
	}
	if err := c.Get(ctx, key, &pvc); err != nil || pvcVersion != pvc.ResourceVersion {
		t.Fatalf("PVC changed on retry: %v", err)
	}
	step.Status = RunStatus{Phase: "Completed", Result: &ExecuteResult{Version: 1, OperationID: operation, ProjectID: run.Spec.ProjectID, Loop: "router", Phase: "Completed", Result: TriageResult{RoutingIntent: "INQUIRY", Complexity: "LOW", Summary: "Information request"}}}
	if err := c.Status().Update(ctx, &step); err != nil {
		t.Fatal(err)
	}
	reconcile(t, c, run)
	if err := c.Get(ctx, client.ObjectKeyFromObject(run), run); err != nil {
		t.Fatal(err)
	}
	if run.Status.Phase != "Completed" || run.Status.Result.Result.RoutingIntent != "INQUIRY" {
		t.Fatalf("missing structured result: %+v", run.Status)
	}
}
func TestWorkerHasOnlyItsExecutionStatusPermission(t *testing.T) {
	c, run := fixture(t)
	reconcile(t, c, run)
	var role rbacv1.Role
	if err := c.Get(context.Background(), types.NamespacedName{Namespace: run.Namespace, Name: executionName(run)}, &role); err != nil {
		t.Fatal(err)
	}
	if len(role.Rules) != 2 {
		t.Fatal("unexpected worker permissions")
	}
	for _, rule := range role.Rules {
		if len(rule.ResourceNames) != 1 || rule.ResourceNames[0] != executionName(run) {
			t.Fatal("worker can access another execution")
		}
	}
}
func TestForeignExecutionIsRefused(t *testing.T) {
	c, run := fixture(t)
	foreign := &StepExecution{ObjectMeta: metav1.ObjectMeta{Name: executionName(run), Namespace: run.Namespace}, Spec: ExecuteRequest{ProjectID: "foreign"}}
	if err := c.Create(context.Background(), foreign); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(run)}); err == nil {
		t.Fatal("adopted foreign execution")
	}
}
func TestReceiptMustMatchExecutionAndTypedOutcome(t *testing.T) {
	req := ExecuteRequest{Version: 1, OperationID: "op", ProjectID: "project", Loop: "router"}
	valid := ExecuteResult{Version: 1, OperationID: "op", ProjectID: "project", Loop: "router", Phase: "Completed", Result: TriageResult{RoutingIntent: "INQUIRY", Complexity: "LOW", Summary: "Explain"}}
	if err := validateResult(req, valid); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []ExecuteResult{
		{Version: 1, OperationID: "another", ProjectID: "project", Loop: "router", Phase: "Completed", Result: valid.Result},
		{Version: 1, OperationID: "op", ProjectID: "another", Loop: "router", Phase: "Completed", Result: valid.Result},
		{Version: 1, OperationID: "op", ProjectID: "project", Loop: "router", Phase: "Completed", Result: TriageResult{Summary: "plain prose"}},
		{Version: 1, OperationID: "op", ProjectID: "project", Loop: "router", Phase: "Completed", Result: TriageResult{RoutingIntent: "INQUIRY", Complexity: "LOW", Summary: "Explain", WorkKind: "FEATURE"}},
		{Version: 1, OperationID: "op", ProjectID: "project", Loop: "router", Phase: "Completed", Result: TriageResult{RoutingIntent: "QUICK_FIX", Complexity: "LOW", Summary: "Fix", Classification: "PROJECT"}},
	} {
		if err := validateResult(req, invalid); err == nil {
			t.Fatal("accepted invalid receipt")
		}
	}
}

type admissionObserver struct {
	client.Client
	t   *testing.T
	run *FactoryRun
}

func (c *admissionObserver) Create(ctx context.Context, obj client.Object, opts ...client.CreateOption) error {
	if _, ok := obj.(*batchv1.Job); ok {
		var stored FactoryRun
		if err := c.Get(ctx, client.ObjectKeyFromObject(c.run), &stored); err != nil {
			c.t.Fatal(err)
		}
		if stored.Status.Phase != "Running" {
			c.t.Fatal("worker started before durable project claim")
		}
	}
	return c.Client.Create(ctx, obj, opts...)
}

func TestProjectClaimPrecedesWorkerAndSurvivesControllerRestart(t *testing.T) {
	c, run := fixture(t)
	c.Client = &admissionObserver{Client: c.Client, t: t, run: run}
	reconcile(t, c, run)
	other := &FactoryRun{ObjectMeta: metav1.ObjectMeta{Name: "another", Namespace: run.Namespace, UID: "another-uid"}, Spec: run.Spec}
	if err := c.Create(context.Background(), other); err != nil {
		t.Fatal(err)
	}
	reconcile(t, c, other)
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(other), other); err != nil {
		t.Fatal(err)
	}
	if other.Status.Phase != "Accepted" {
		t.Fatal("second run did not wait for project claim")
	}
	var jobs batchv1.JobList
	if err := c.List(context.Background(), &jobs); err != nil {
		t.Fatal(err)
	}
	if len(jobs.Items) != 1 {
		t.Fatal("started simultaneous jobs for one project")
	}
}

func TestOnlyPublicationWorkersMountGitHubCredential(t *testing.T) {
	c, run := fixture(t)
	c.GitHubSecret = "github-auth"
	plain := c.job(metav1.ObjectMeta{Name: "worker"}, run)
	for _, volume := range plain.Spec.Template.Spec.Volumes {
		if volume.Name == "github" {
			t.Fatal("plain router received GitHub credential")
		}
	}
	run.Spec.Publication = &GitHubPublication{Kind: "github-issue-comment", Repository: "owner/repo", RepositoryID: "42", IssueID: "1001", IssueNumber: 1}
	job := c.job(metav1.ObjectMeta{Name: "worker"}, run)
	found := false
	for _, volume := range job.Spec.Template.Spec.Volumes {
		if volume.Name == "github" && volume.Secret.SecretName == "github-auth" {
			found = true
		}
	}
	if !found {
		t.Fatal("publisher missing GitHub credential")
	}
}
func TestPublicationReceiptRequiresExactIssueWithCanonicalCasing(t *testing.T) {
	request := ExecuteRequest{Version: 1, OperationID: "op", ProjectID: "p", Loop: "router", Publication: &GitHubPublication{Repository: "owner/repo", IssueNumber: 1}}
	result := ExecuteResult{Version: 1, OperationID: "op", ProjectID: "p", Loop: "router", Phase: "Completed", Result: TriageResult{RoutingIntent: "INQUIRY", Complexity: "LOW", Summary: "Question"}, Publication: &PublicationReceipt{CommentID: "123", URL: "https://github.com/Owner/Repo/issues/1#issuecomment-123"}}
	if err := validateResult(request, result); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"https://github.com/owner/repo/issues/2#issuecomment-123", "https://github.com/owner/repo/issues/1?q=x#issuecomment-123", "https://user@github.com/owner/repo/issues/1#issuecomment-123"} {
		result.Publication.URL = bad
		if err := validateResult(request, result); err == nil {
			t.Fatalf("accepted invalid publication %s", bad)
		}
	}
	result.Publication = nil
	if err := validateResult(request, result); err == nil {
		t.Fatal("accepted routing without requested publication")
	}
}

func TestForeignProjectCannotStartWorker(t *testing.T) {
	c, run := fixture(t)
	if err := c.Delete(context.Background(), bindingForTest(run.Namespace, run.Spec.ProjectID)); err != nil {
		t.Fatal(err)
	}
	reconcile(t, c, run)
	ctx := context.Background()
	if err := c.Get(ctx, client.ObjectKeyFromObject(run), run); err != nil || run.Status.Phase != "Rejected" {
		t.Fatalf("expected a rejected run: %s, %v", run.Status.Phase, err)
	}
	var steps StepExecutionList
	if err := c.List(ctx, &steps); err != nil || len(steps.Items) != 0 {
		t.Fatalf("foreign project created work: %v, %v", steps.Items, err)
	}
}

func TestWorkerCarriesControllerProjectBinding(t *testing.T) {
	c, run := fixture(t)
	job := c.job(metav1.ObjectMeta{Name: "worker"}, run)
	for _, env := range job.Spec.Template.Spec.Containers[0].Env {
		if env.Name == "WLD_FACTORY_PROJECT_ID" && env.ValueFrom != nil && env.ValueFrom.ConfigMapKeyRef != nil && env.ValueFrom.ConfigMapKeyRef.Name == projectBindingName(run.Spec.ProjectID) && env.ValueFrom.ConfigMapKeyRef.Key == "projectId" {
			return
		}
	}
	t.Fatal("worker is missing the controller Project binding")
}

func bindingForTest(namespace, projectID string) *corev1.ConfigMap {
	return &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: projectBindingName(projectID), Namespace: namespace}, Immutable: ptr(true), Data: map[string]string{"projectId": projectID}}
}

func TestAdmissionDistinguishesProjectsInOneNamespace(t *testing.T) {
	c, first := fixture(t)
	ctx := context.Background()
	second := bindingForTest(first.Namespace, "second-project")
	if err := c.Create(ctx, second); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{first.Spec.ProjectID, second.Data["projectId"]} {
		ok, err := projectAdmitted(ctx, c.Client, first.Namespace, id)
		if err != nil || !ok {
			t.Fatalf("expected admission for %s: %v", id, err)
		}
		ok, err = projectAdmitted(ctx, c.Client, "another-tenant", id)
		if err != nil || ok {
			t.Fatalf("unexpected admission across namespace: %v", err)
		}
	}
	wrong := bindingForTest(first.Namespace, "wrong-project")
	wrong.Data["projectId"] = first.Spec.ProjectID
	if err := c.Create(ctx, wrong); err != nil {
		t.Fatal(err)
	}
	ok, err := projectAdmitted(ctx, c.Client, first.Namespace, "wrong-project")
	if err != nil || ok {
		t.Fatalf("unexpected admission through a mismatched binding: %v", err)
	}
}
