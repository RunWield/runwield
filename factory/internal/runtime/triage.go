package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	kruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

type GitHubTriageSpec struct {
	ProjectID     string   `json:"projectId"`
	Repository    string   `json:"repository"`
	RepositoryID  string   `json:"repositoryId"`
	Label         string   `json:"label"`
	ExcludeLabels []string `json:"excludeLabels,omitempty"`
	Mode          string   `json:"mode"`
	Model         string   `json:"model"`
}
type SelectedIssue struct {
	ID      string `json:"id"`
	Number  int    `json:"number"`
	RunName string `json:"runName"`
}
type TriageStatus struct {
	RetryAt         *metav1.Time    `json:"retryAt,omitempty"`
	Phase           string          `json:"phase,omitempty"`
	SelectionSealed bool            `json:"selectionSealed,omitempty"`
	Selected        []SelectedIssue `json:"selected,omitempty"`
	Completed       int             `json:"completed,omitempty"`
	Message         string          `json:"message,omitempty"`
}
type GitHubTriage struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              GitHubTriageSpec `json:"spec"`
	Status            TriageStatus     `json:"status,omitempty"`
}
type GitHubTriageList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []GitHubTriage `json:"items"`
}

func (r *GitHubTriage) DeepCopyObject() kruntime.Object {
	c := *r
	c.ObjectMeta = *r.ObjectMeta.DeepCopy()
	c.Spec.ExcludeLabels = append([]string(nil), r.Spec.ExcludeLabels...)
	if r.Status.RetryAt != nil {
		c.Status.RetryAt = r.Status.RetryAt.DeepCopy()
	}
	c.Status.Selected = append([]SelectedIssue(nil), r.Status.Selected...)
	return &c
}
func (r *GitHubTriageList) DeepCopyObject() kruntime.Object {
	c := *r
	c.ListMeta = *r.ListMeta.DeepCopy()
	c.Items = make([]GitHubTriage, len(r.Items))
	for i := range r.Items {
		c.Items[i] = *r.Items[i].DeepCopyObject().(*GitHubTriage)
	}
	return &c
}
func issueRunName(repositoryID, issueID string) string {
	digest := sha256.Sum256([]byte(repositoryID + ":" + issueID))
	return fmt.Sprintf("github-%x", digest[:24])
}

type TriageController struct {
	client.Client
	GitHub *GitHub
}

func (c *TriageController) Reconcile(ctx context.Context, key ctrl.Request) (ctrl.Result, error) {
	var triage GitHubTriage
	if err := c.Get(ctx, key.NamespacedName, &triage); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !triage.DeletionTimestamp.IsZero() || triage.Status.Phase == "Completed" || triage.Status.Phase == "Rejected" {
		return ctrl.Result{}, nil
	}
	admitted, err := projectAdmitted(ctx, c.Client, triage.Namespace, triage.Spec.ProjectID)
	if err != nil {
		return ctrl.Result{}, err
	}
	if !admitted {
		// Retain the sealed selection or retry state without accessing GitHub.
		if triage.Status.Phase != "" {
			return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
		}
		before := triage.DeepCopyObject().(*GitHubTriage)
		triage.Status.Phase = "Rejected"
		triage.Status.Message = "Project is not registered for this Factory namespace"
		return ctrl.Result{}, c.Status().Patch(ctx, &triage, client.MergeFrom(before))
	}
	if triage.Status.RetryAt != nil && time.Now().Before(triage.Status.RetryAt.Time) {
		return ctrl.Result{RequeueAfter: time.Until(triage.Status.RetryAt.Time)}, nil
	}
	before := triage.DeepCopyObject().(*GitHubTriage)
	triage.Status.RetryAt = nil
	if !triage.Status.SelectionSealed {
		var runs FactoryRunList
		var intakes GitHubTriageList
		if err := c.List(ctx, &runs, client.InNamespace(triage.Namespace)); err != nil {
			return ctrl.Result{}, err
		}
		if err := c.List(ctx, &intakes, client.InNamespace(triage.Namespace)); err != nil {
			return ctrl.Result{}, err
		}
		claimed := map[string]bool{}
		busy := false
		for _, run := range runs.Items {
			claimed[run.Name] = true
			if run.Spec.ProjectID == triage.Spec.ProjectID && run.Status.Phase != "Completed" && run.Status.Phase != "Rejected" {
				busy = true
			}
		}
		for _, intake := range intakes.Items {
			if intake.Name == triage.Name {
				continue
			}
			for _, selected := range intake.Status.Selected {
				claimed[selected.RunName] = true
			}
			if intake.Spec.ProjectID == triage.Spec.ProjectID && intake.Status.Phase != "Completed" && intake.Status.Phase != "Rejected" && (intake.Status.SelectionSealed || intake.Spec.Mode == "batch") {
				busy = true
			}
		}
		triage.Status.SelectionSealed = true
		triage.Status.Phase = "Admitted"
		if triage.Spec.Mode == "next" && busy {
			triage.Status.Message = "No admission: project has unfinished work"
		} else {
			selected, err := c.GitHub.selectIssues(ctx, triage.Spec, claimed)
			if err != nil {
				triage.Status.SelectionSealed = false
				return c.retry(ctx, &triage, before, err)
			}
			triage.Status.Selected = selected
			triage.Status.Message = fmt.Sprintf("Selection frozen: %d issue(s)", len(selected))
		}
		if len(triage.Status.Selected) == 0 {
			triage.Status.Phase = "Completed"
		}
		// This write is the claim and finite selection boundary. Recover exactly this set.
		if err := c.Status().Patch(ctx, &triage, client.MergeFrom(before)); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: time.Millisecond}, nil
	}
	completed := 0
	for _, selected := range triage.Status.Selected {
		var run FactoryRun
		err := c.Get(ctx, types.NamespacedName{Namespace: triage.Namespace, Name: selected.RunName}, &run)
		if apierrors.IsNotFound(err) {
			if err := c.GitHub.verify(ctx, triage.Spec); err != nil {
				return c.retry(ctx, &triage, before, err)
			}
			issue, err := c.GitHub.issue(ctx, triage.Spec, selected)
			if err != nil {
				return c.retry(ctx, &triage, before, err)
			}
			run = FactoryRun{ObjectMeta: metav1.ObjectMeta{Name: selected.RunName, Namespace: triage.Namespace, Labels: map[string]string{"factory.runwield.dev/intake": triage.Name}}, Spec: RunSpec{
				ProjectID: triage.Spec.ProjectID, Loop: "router", Model: triage.Spec.Model,
				Input:       Input{Prompt: "Title: " + issue.Title + "\n\nBody:\n" + issue.Body},
				Publication: &GitHubPublication{Kind: "github-issue-comment", Repository: triage.Spec.Repository, RepositoryID: triage.Spec.RepositoryID, IssueID: selected.ID, IssueNumber: selected.Number},
			}}
			// Deliberately no owner reference: deleting a batch must not erase work or deduplication history.
			if err := c.Create(ctx, &run); err != nil && !apierrors.IsAlreadyExists(err) {
				return ctrl.Result{}, err
			}
			if err := c.Get(ctx, client.ObjectKeyFromObject(&run), &run); err != nil {
				return ctrl.Result{}, err
			}
		} else if err != nil {
			return ctrl.Result{}, err
		}
		publication := run.Spec.Publication
		if publication == nil || publication.RepositoryID != triage.Spec.RepositoryID || publication.IssueID != selected.ID || publication.IssueNumber != selected.Number || run.Spec.ProjectID != triage.Spec.ProjectID {
			return ctrl.Result{}, fmt.Errorf("issue claim conflicts with existing FactoryRun %s", selected.RunName)
		}
		if run.Status.Phase == "Completed" {
			completed++
		}
	}
	triage.Status.Completed = completed
	triage.Status.Phase = "Running"
	if completed == len(triage.Status.Selected) {
		triage.Status.Phase = "Completed"
	}
	triage.Status.Message = fmt.Sprintf("%d/%d issue comments published", completed, len(triage.Status.Selected))
	if err := c.Status().Patch(ctx, &triage, client.MergeFrom(before)); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
}

// A CronJob retry creates the same wake, even if its first API acknowledgement was lost.
func AdmitWake(ctx context.Context, c client.Client, namespace, jobName, recipePath string) error {
	if jobName == "" {
		return fmt.Errorf("FACTORY_WAKE_JOB is required")
	}
	data, err := os.ReadFile(recipePath)
	if err != nil {
		return err
	}
	var spec GitHubTriageSpec
	if err := json.Unmarshal(data, &spec); err != nil {
		return err
	}
	if spec.Mode != "next" {
		return fmt.Errorf("scheduled recipe must use next mode")
	}
	digest := sha256.Sum256([]byte(jobName))
	intake := &GitHubTriage{ObjectMeta: metav1.ObjectMeta{Name: fmt.Sprintf("wake-%x", digest[:24]), Namespace: namespace}, Spec: spec}
	if err := c.Create(ctx, intake); err != nil && !apierrors.IsAlreadyExists(err) {
		return err
	}
	var existing GitHubTriage
	if err := c.Get(ctx, client.ObjectKeyFromObject(intake), &existing); err != nil {
		return err
	}
	want, _ := json.Marshal(spec)
	got, _ := json.Marshal(existing.Spec)
	if string(want) != string(got) {
		return fmt.Errorf("wake identity reused with different recipe")
	}
	fmt.Println(existing.Name)
	return nil
}

// Persist remote backoff so status events and controller restarts cannot bypass it.
func (c *TriageController) retry(ctx context.Context, triage, before *GitHubTriage, err error) (ctrl.Result, error) {
	retryAt := time.Now().Add(15 * time.Minute)
	var remote *githubReadFailure
	if errors.As(err, &remote) && remote.RetryAt.After(retryAt) {
		retryAt = remote.RetryAt
	}
	triage.Status.RetryAt = &metav1.Time{Time: retryAt}
	triage.Status.Phase = "Retrying"
	triage.Status.Message = err.Error()
	if patchErr := c.Status().Patch(ctx, triage, client.MergeFrom(before)); patchErr != nil {
		return ctrl.Result{}, patchErr
	}
	return ctrl.Result{RequeueAfter: time.Until(retryAt)}, nil
}
