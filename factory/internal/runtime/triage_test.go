package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	kruntime "k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

// The only replacement boundary is GitHub's HTTP transport.
type githubTransport struct {
	server    string
	transport http.RoundTripper
}

func (t githubTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Host != "api.github.com" || r.URL.Scheme != "https" {
		return nil, fmt.Errorf("unexpected API destination")
	}
	r = r.Clone(r.Context())
	r.URL.Scheme = "http"
	r.URL.Host = strings.TrimPrefix(t.server, "http://")
	return t.transport.RoundTrip(r)
}
func githubFixture(t *testing.T, handler http.HandlerFunc) *GitHub {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("fixture-credential"), 0600); err != nil {
		t.Fatal(err)
	}
	g := NewGitHub(tokenFile)
	g.HTTP.Transport = githubTransport{server.URL, http.DefaultTransport}
	return g
}
func triageSpec(mode string) GitHubTriageSpec {
	return GitHubTriageSpec{ProjectID: "stable-project", Repository: "owner/repo", RepositoryID: "42", Label: "test", ExcludeLabels: []string{"status:in-progress"}, Mode: mode, Model: "openai/gpt-6.1-sol"}
}
func issueFixture(number int) githubIssue {
	return githubIssue{ID: int64(1000 + number), Number: number, Title: fmt.Sprintf("Issue %d", number), Body: "body", State: "open", Labels: []githubLabel{{Name: "test"}}}
}
func triageFixture(t *testing.T, mode string) (*TriageController, *GitHubTriage) {
	t.Helper()
	scheme := kruntime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	intake := &GitHubTriage{ObjectMeta: metav1.ObjectMeta{Name: "intake", Namespace: "tenant"}, Spec: triageSpec(mode)}
	kube := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&GitHubTriage{}, &FactoryRun{}).WithObjects(intake, bindingForTest(intake.Namespace, intake.Spec.ProjectID)).Build()
	g := githubFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/repos/owner/repo":
			_ = json.NewEncoder(w).Encode(githubRepository{ID: 42, FullName: "owner/repo"})
		case r.URL.Path == "/repos/owner/repo/issues":
			issues := []githubIssue{}
			for i := 1; i <= 12; i++ {
				issues = append(issues, issueFixture(i))
			}
			_ = json.NewEncoder(w).Encode(issues)
		default:
			var number int
			_, _ = fmt.Sscanf(r.URL.Path, "/repos/owner/repo/issues/%d", &number)
			_ = json.NewEncoder(w).Encode(issueFixture(number))
		}
	})
	return &TriageController{Client: kube, GitHub: g}, intake
}
func intakeReconcile(t *testing.T, c *TriageController, intake *GitHubTriage) {
	t.Helper()
	if _, err := c.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(intake)}); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(intake), intake); err != nil {
		t.Fatal(err)
	}
}
func TestBatchFreezesTenAndRecoversAdmissionBeforeWakeSelectsNext(t *testing.T) {
	c, batch := triageFixture(t, "batch")
	ctx := context.Background()
	intakeReconcile(t, c, batch)
	if !batch.Status.SelectionSealed || len(batch.Status.Selected) != 10 || batch.Status.Selected[0].Number != 1 || batch.Status.Selected[9].Number != 10 {
		t.Fatalf("bad selection: %+v", batch.Status)
	}
	// Crash after freezing selection, before creating any FactoryRun. The wake must not steal work.
	wake := &GitHubTriage{ObjectMeta: metav1.ObjectMeta{Name: "wake-busy", Namespace: "tenant"}, Spec: triageSpec("next")}
	if err := c.Create(context.Background(), wake); err != nil {
		t.Fatal(err)
	}
	intakeReconcile(t, c, wake)
	if wake.Status.Phase != "Completed" || len(wake.Status.Selected) != 0 {
		t.Fatal("wake admitted while batch pending")
	}
	binding := bindingForTest(batch.Namespace, batch.Spec.ProjectID)
	if err := c.Delete(ctx, binding); err != nil {
		t.Fatal(err)
	}
	selection := slices.Clone(batch.Status.Selected)
	github := c.GitHub
	c.GitHub = nil
	result, err := c.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(batch)})
	if err != nil || result.RequeueAfter <= 0 {
		t.Fatalf("expected the batch to wait for its Project binding: %+v, %v", result, err)
	}
	if err := c.Get(ctx, client.ObjectKeyFromObject(batch), batch); err != nil {
		t.Fatal(err)
	}
	if batch.Status.Phase != "Admitted" || !batch.Status.SelectionSealed || !slices.Equal(batch.Status.Selected, selection) {
		t.Fatalf("expected to retain the admitted selection: %+v", batch.Status)
	}
	var runs FactoryRunList
	if err := c.List(ctx, &runs); err != nil || len(runs.Items) != 0 {
		t.Fatalf("batch created runs without the binding: %v, %v", runs.Items, err)
	}
	unbound := &GitHubTriage{ObjectMeta: metav1.ObjectMeta{Name: "unbound-batch", Namespace: batch.Namespace}, Spec: batch.Spec}
	if err := c.Create(ctx, unbound); err != nil {
		t.Fatal(err)
	}
	intakeReconcile(t, c, unbound)
	if unbound.Status.Phase != "Rejected" {
		t.Fatalf("expected the new unbound intake to be rejected: %s", unbound.Status.Phase)
	}
	if err := c.Create(ctx, binding); err != nil {
		t.Fatal(err)
	}
	c.GitHub = github
	intakeReconcile(t, c, batch)
	intakeReconcile(t, c, batch)
	if err := c.List(context.Background(), &runs); err != nil {
		t.Fatal(err)
	}
	if len(runs.Items) != 10 {
		t.Fatalf("got %d runs", len(runs.Items))
	}
	for i := range runs.Items {
		run := &runs.Items[i]
		if run.Spec.Publication == nil || run.Spec.Input.Prompt != fmt.Sprintf("Title: Issue %d\n\nBody:\nbody", run.Spec.Publication.IssueNumber) {
			t.Fatalf("wrong Router input %+v", run.Spec)
		}
		if len(run.OwnerReferences) != 0 {
			t.Fatal("deleting intake would erase claim")
		}
		run.Status.Phase = "Completed"
		if err := c.Status().Update(context.Background(), run); err != nil {
			t.Fatal(err)
		}
	}
	intakeReconcile(t, c, batch)
	if batch.Status.Completed != 10 || batch.Status.Phase != "Completed" {
		t.Fatal("batch not completed")
	}
	next := &GitHubTriage{ObjectMeta: metav1.ObjectMeta{Name: "wake-next", Namespace: "tenant"}, Spec: triageSpec("next")}
	if err := c.Create(context.Background(), next); err != nil {
		t.Fatal(err)
	}
	intakeReconcile(t, c, next)
	intakeReconcile(t, c, next)
	if len(next.Status.Selected) != 1 || next.Status.Selected[0].Number != 11 {
		t.Fatalf("wake did not skip claimed issues: %+v", next.Status)
	}
}
func TestGitHubSelectionPaginatesAndSkipsPRsClaimsAndWorkLabels(t *testing.T) {
	calls := 0
	g := githubFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-credential" {
			t.Error("missing auth")
		}
		if r.URL.Path == "/repos/owner/repo" {
			_ = json.NewEncoder(w).Encode(githubRepository{ID: 42, FullName: "owner/repo"})
			return
		}
		calls++
		if r.URL.Query().Get("sort") != "created" || r.URL.Query().Get("direction") != "asc" {
			t.Error("not oldest first")
		}
		issues := []githubIssue{}
		if r.URL.Query().Get("page") == "1" {
			for i := 1; i <= 100; i++ {
				issues = append(issues, issueFixture(i))
			}
		} else {
			pr := issueFixture(101)
			raw := json.RawMessage(`{}`)
			pr.PullRequest = &raw
			busy := issueFixture(102)
			busy.Labels = append(busy.Labels, githubLabel{Name: "status:in-progress"})
			issues = []githubIssue{pr, busy, issueFixture(103)}
		}
		_ = json.NewEncoder(w).Encode(issues)
	})
	claims := map[string]bool{}
	for i := 1; i <= 100; i++ {
		claims[issueRunName("42", fmt.Sprint(1000+i))] = true
	}
	selected, err := g.selectIssues(context.Background(), triageSpec("next"), claims)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || len(selected) != 1 || selected[0].Number != 103 {
		t.Fatalf("wrong selection %+v", selected)
	}
}
func TestEmptySelectionAndRepositoryMismatch(t *testing.T) {
	c, intake := triageFixture(t, "batch")
	c.GitHub = githubFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/owner/repo" {
			_ = json.NewEncoder(w).Encode(githubRepository{ID: 42, FullName: "owner/repo"})
		} else {
			_, _ = w.Write([]byte(`[]`))
		}
	})
	intakeReconcile(t, c, intake)
	if intake.Status.Phase != "Completed" || !intake.Status.SelectionSealed || len(intake.Status.Selected) != 0 {
		t.Fatal("empty selection was not completed")
	}
	spec := triageSpec("batch")
	spec.RepositoryID = "43"
	if _, err := c.GitHub.selectIssues(context.Background(), spec, map[string]bool{}); err == nil {
		t.Fatal("repository identity mismatch accepted")
	}
}
func TestWakeRetriesUseSameAdmission(t *testing.T) {
	c, _ := triageFixture(t, "next")
	path := filepath.Join(t.TempDir(), "recipe.json")
	data, _ := json.Marshal(triageSpec("next"))
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := AdmitWake(context.Background(), c.Client, "tenant", "cron-job-123", path); err != nil {
			t.Fatal(err)
		}
	}
	var intakes GitHubTriageList
	if err := c.List(context.Background(), &intakes); err != nil {
		t.Fatal(err)
	}
	if len(intakes.Items) != 2 {
		t.Fatalf("retry duplicated wake: %d", len(intakes.Items))
	}
}

func TestGitHubRateBackoffSurvivesControllerReconcile(t *testing.T) {
	c, intake := triageFixture(t, "batch")
	calls := 0
	c.GitHub = githubFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Retry-After", "3600")
		w.WriteHeader(http.StatusTooManyRequests)
	})
	intakeReconcile(t, c, intake)
	if intake.Status.Phase != "Retrying" || intake.Status.SelectionSealed || intake.Status.RetryAt == nil {
		t.Fatalf("missing durable retry: %+v", intake.Status)
	}
	intakeReconcile(t, c, intake)
	if calls != 1 {
		t.Fatal("status event bypassed GitHub backoff")
	}
}

func TestForeignProjectCannotReadOrClaimIssues(t *testing.T) {
	c, intake := triageFixture(t, "batch")
	if err := c.Delete(context.Background(), bindingForTest(intake.Namespace, intake.Spec.ProjectID)); err != nil {
		t.Fatal(err)
	}
	c.GitHub = nil // A rejected intake must finish before contacting GitHub.
	intakeReconcile(t, c, intake)
	if intake.Status.Phase != "Rejected" || intake.Status.SelectionSealed || len(intake.Status.Selected) != 0 {
		t.Fatalf("foreign intake was admitted: %+v", intake.Status)
	}
}
