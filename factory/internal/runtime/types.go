package runtime

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	kruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

var GroupVersion = schema.GroupVersion{Group: "factory.runwield.dev", Version: "v1alpha1"}

type Input struct {
	Prompt string `json:"prompt"`
}
type GitHubPublication struct {
	Kind         string `json:"kind"`
	Repository   string `json:"repository"`
	RepositoryID string `json:"repositoryId"`
	IssueNumber  int    `json:"issueNumber"`
	IssueID      string `json:"issueId"`
}
type PublicationReceipt struct {
	CommentID string `json:"commentId"`
	URL       string `json:"url"`
}
type RunSpec struct {
	Publication *GitHubPublication `json:"publication,omitempty"`
	ProjectID   string             `json:"projectId"`
	Loop        string             `json:"loop"`
	Input       Input              `json:"input"`
	Model       string             `json:"model,omitempty"`
}
type TriageResult struct {
	RoutingIntent  string `json:"routingIntent"`
	Classification string `json:"classification,omitempty"`
	WorkKind       string `json:"workKind,omitempty"`
	Complexity     string `json:"complexity"`
	Summary        string `json:"summary"`
	SessionName    string `json:"sessionName,omitempty"`
}
type ExecuteRequest struct {
	Publication *GitHubPublication `json:"publication,omitempty"`
	Version     int                `json:"version"`
	OperationID string             `json:"operationId"`
	ProjectID   string             `json:"projectId"`
	Loop        string             `json:"loop"`
	Cwd         string             `json:"cwd"`
	Input       Input              `json:"input"`
	Model       string             `json:"model,omitempty"`
}
type ExecuteResult struct {
	Publication *PublicationReceipt `json:"publication,omitempty"`
	Version     int                 `json:"version"`
	OperationID string              `json:"operationId"`
	ProjectID   string              `json:"projectId"`
	Loop        string              `json:"loop"`
	Phase       string              `json:"phase"`
	Result      TriageResult        `json:"result"`
}
type RunStatus struct {
	Phase         string             `json:"phase,omitempty"`
	ExecutionName string             `json:"executionName,omitempty"`
	Result        *ExecuteResult     `json:"result,omitempty"`
	Conditions    []metav1.Condition `json:"conditions,omitempty"`
}
type FactoryRun struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              RunSpec   `json:"spec"`
	Status            RunStatus `json:"status,omitempty"`
}
type FactoryRunList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []FactoryRun `json:"items"`
}
type StepExecution struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              ExecuteRequest `json:"spec"`
	Status            RunStatus      `json:"status,omitempty"`
}
type StepExecutionList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []StepExecution `json:"items"`
}

func copyStatus(s RunStatus) RunStatus {
	if s.Result != nil {
		r := *s.Result
		if r.Publication != nil {
			p := *r.Publication
			r.Publication = &p
		}
		s.Result = &r
	}
	s.Conditions = append([]metav1.Condition(nil), s.Conditions...)
	return s
}
func (r *FactoryRun) DeepCopyObject() kruntime.Object {
	c := *r
	c.ObjectMeta = *r.ObjectMeta.DeepCopy()
	c.Status = copyStatus(r.Status)
	if r.Spec.Publication != nil {
		p := *r.Spec.Publication
		c.Spec.Publication = &p
	}
	return &c
}
func (r *StepExecution) DeepCopyObject() kruntime.Object {
	c := *r
	c.ObjectMeta = *r.ObjectMeta.DeepCopy()
	c.Status = copyStatus(r.Status)
	if r.Spec.Publication != nil {
		p := *r.Spec.Publication
		c.Spec.Publication = &p
	}
	return &c
}
func (r *FactoryRunList) DeepCopyObject() kruntime.Object {
	c := *r
	c.ListMeta = *r.ListMeta.DeepCopy()
	c.Items = make([]FactoryRun, len(r.Items))
	for i := range r.Items {
		c.Items[i] = *r.Items[i].DeepCopyObject().(*FactoryRun)
	}
	return &c
}
func (r *StepExecutionList) DeepCopyObject() kruntime.Object {
	c := *r
	c.ListMeta = *r.ListMeta.DeepCopy()
	c.Items = make([]StepExecution, len(r.Items))
	for i := range r.Items {
		c.Items[i] = *r.Items[i].DeepCopyObject().(*StepExecution)
	}
	return &c
}
func AddToScheme(s *kruntime.Scheme) error {
	s.AddKnownTypes(GroupVersion, &FactoryRun{}, &FactoryRunList{}, &StepExecution{}, &StepExecutionList{}, &GitHubTriage{}, &GitHubTriageList{})
	metav1.AddToGroupVersion(s, GroupVersion)
	return nil
}
