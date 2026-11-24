package runtime

import (
	"context"
	"fmt"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	kruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"time"
)

// Controller owns orchestration only. wld owns the Router operation and its receipt.
type Controller struct {
	client.Client
	Scheme           *kruntime.Scheme
	Image            string
	CredentialSecret string
	GitHubSecret     string
}

func ptr[T any](v T) *T                    { return &v }
func executionName(run *FactoryRun) string { return "router-" + string(run.UID) }

func (c *Controller) Reconcile(ctx context.Context, key ctrl.Request) (ctrl.Result, error) {
	var run FactoryRun
	if err := c.Get(ctx, key.NamespacedName, &run); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !run.DeletionTimestamp.IsZero() || run.Status.Phase == "Completed" || run.Status.Phase == "Rejected" {
		return ctrl.Result{}, nil
	}
	admitted, err := projectAdmitted(ctx, c.Client, run.Namespace, run.Spec.ProjectID)
	if err != nil {
		return ctrl.Result{}, err
	}
	if !admitted {
		// Retain the execution and its place in the project queue until the binding returns.
		if run.Status.Phase != "" {
			return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
		}
		before := run.DeepCopyObject().(*FactoryRun)
		run.Status.Phase = "Rejected"
		meta.SetStatusCondition(&run.Status.Conditions, metav1.Condition{Type: "Completed", Status: metav1.ConditionFalse, Reason: "ProjectMismatch", Message: "Project is not registered for this Factory namespace", ObservedGeneration: run.Generation})
		return ctrl.Result{}, c.Status().Patch(ctx, &run, client.MergeFrom(before))
	}
	if run.Spec.Publication != nil && c.GitHubSecret == "" {
		return ctrl.Result{}, fmt.Errorf("GitHub publication credentials are not configured")
	}
	name := executionName(&run)
	owner := []metav1.OwnerReference{*metav1.NewControllerRef(&run, GroupVersion.WithKind("FactoryRun"))}
	metadata := func() metav1.ObjectMeta {
		return metav1.ObjectMeta{Name: name, Namespace: run.Namespace, OwnerReferences: owner}
	}
	step := &StepExecution{ObjectMeta: metadata(), Spec: ExecuteRequest{Version: 1, OperationID: string(run.UID) + ":router", ProjectID: run.Spec.ProjectID, Loop: run.Spec.Loop, Cwd: "/data/workspace", Input: run.Spec.Input, Model: run.Spec.Model, Publication: run.Spec.Publication}}
	if err := c.ensure(ctx, step); err != nil {
		return ctrl.Result{}, err
	}
	if err := c.Get(ctx, types.NamespacedName{Namespace: run.Namespace, Name: name}, step); err != nil {
		return ctrl.Result{}, err
	}
	before := run.DeepCopyObject().(*FactoryRun)
	run.Status.ExecutionName = name
	if step.Status.Phase == "Completed" && step.Status.Result != nil {
		if err := validateResult(step.Spec, *step.Status.Result); err != nil {
			return ctrl.Result{}, err
		}
		run.Status.Phase = "Completed"
		run.Status.Result = step.Status.Result
		meta.SetStatusCondition(&run.Status.Conditions, metav1.Condition{Type: "Completed", Status: metav1.ConditionTrue, Reason: "RouterResultPersisted", Message: "Structured Router result is available", ObservedGeneration: run.Generation})
		return ctrl.Result{}, c.Status().Patch(ctx, &run, client.MergeFrom(before))
	}
	// A single controller reconciles serially; existing live runs for this project go first.
	var runs FactoryRunList
	if err := c.List(ctx, &runs, client.InNamespace(run.Namespace)); err != nil {
		return ctrl.Result{}, err
	}
	for _, other := range runs.Items {
		if other.UID != run.UID && other.Spec.ProjectID == run.Spec.ProjectID && other.Status.Phase == "Running" && other.DeletionTimestamp.IsZero() {
			run.Status.Phase = "Accepted"
			if err := c.Status().Patch(ctx, &run, client.MergeFrom(before)); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
		}
	}
	// Persist the project claim before any Job can launch. If reconciliation dies
	// after this patch, another run still waits while this one is recovered.
	run.Status.Phase = "Running"
	meta.SetStatusCondition(&run.Status.Conditions, metav1.Condition{Type: "Completed", Status: metav1.ConditionFalse, Reason: "RouterRunning", Message: "Worker retries recoverable failures with the same operation ID", ObservedGeneration: run.Generation})
	if err := c.Status().Patch(ctx, &run, client.MergeFrom(before)); err != nil {
		return ctrl.Result{}, err
	}
	objects := []client.Object{
		&corev1.PersistentVolumeClaim{ObjectMeta: metadata(), Spec: corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce}, Resources: corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("1Gi")}}}},
		&corev1.ServiceAccount{ObjectMeta: metadata()},
		&rbacv1.Role{ObjectMeta: metadata(), Rules: []rbacv1.PolicyRule{
			{APIGroups: []string{GroupVersion.Group}, Resources: []string{"stepexecutions"}, ResourceNames: []string{name}, Verbs: []string{"get"}},
			{APIGroups: []string{GroupVersion.Group}, Resources: []string{"stepexecutions/status"}, ResourceNames: []string{name}, Verbs: []string{"patch"}},
		}},
		&rbacv1.RoleBinding{ObjectMeta: metadata(), RoleRef: rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "Role", Name: name}, Subjects: []rbacv1.Subject{{Kind: "ServiceAccount", Name: name, Namespace: run.Namespace}}},
	}
	for _, obj := range objects {
		if err := c.ensure(ctx, obj); err != nil {
			return ctrl.Result{}, err
		}
	}
	job := c.job(metadata(), &run)
	if err := c.ensure(ctx, job); err != nil {
		return ctrl.Result{}, err
	}
	// A Job retries pod/process deaths. If its budget is exhausted, recreate it;
	// the same operation ID and PVC recover a committed result without a model call.
	if err := c.Get(ctx, types.NamespacedName{Namespace: run.Namespace, Name: name}, job); err != nil {
		return ctrl.Result{}, err
	}
	for _, condition := range job.Status.Conditions {
		if condition.Type == batchv1.JobFailed && condition.Status == corev1.ConditionTrue {
			if err := c.Delete(ctx, job, client.PropagationPolicy(metav1.DeletePropagationForeground)); err != nil && !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
		}
	}
	return ctrl.Result{RequeueAfter: 10 * time.Second}, nil
}

func (c *Controller) ensure(ctx context.Context, obj client.Object) error {
	err := c.Create(ctx, obj)
	if apierrors.IsAlreadyExists(err) {
		existing := obj.DeepCopyObject().(client.Object)
		if err := c.Get(ctx, client.ObjectKeyFromObject(obj), existing); err != nil {
			return err
		}
		want, got := metav1.GetControllerOf(obj), metav1.GetControllerOf(existing)
		if want == nil || got == nil || want.UID != got.UID {
			return fmt.Errorf("refusing foreign %T %s", obj, obj.GetName())
		}
		return nil
	}
	return err
}

func (c *Controller) job(metadata metav1.ObjectMeta, run *FactoryRun) *batchv1.Job {
	security := &corev1.SecurityContext{AllowPrivilegeEscalation: ptr(false), ReadOnlyRootFilesystem: ptr(true), Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}}
	job := &batchv1.Job{ObjectMeta: metadata, Spec: batchv1.JobSpec{BackoffLimit: ptr(int32(6)), Template: corev1.PodTemplateSpec{
		ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "factory-worker", "factory.runwield.dev/run": run.Name}},
		Spec: corev1.PodSpec{ServiceAccountName: metadata.Name, RestartPolicy: corev1.RestartPolicyNever, SecurityContext: &corev1.PodSecurityContext{RunAsNonRoot: ptr(true), RunAsUser: ptr(int64(1000)), RunAsGroup: ptr(int64(1000)), FSGroup: ptr(int64(1000)), SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault}},
			Containers: []corev1.Container{{Name: "worker", Image: c.Image, ImagePullPolicy: corev1.PullIfNotPresent, Args: []string{"worker"}, SecurityContext: security,
				Env:          []corev1.EnvVar{{Name: "FACTORY_NAMESPACE", Value: run.Namespace}, {Name: "FACTORY_EXECUTION", Value: metadata.Name}, {Name: "HOME", Value: "/data/home"}, {Name: "WLD_FACTORY_PROJECT_ID", ValueFrom: &corev1.EnvVarSource{ConfigMapKeyRef: &corev1.ConfigMapKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: projectBindingName(run.Spec.ProjectID)}, Key: "projectId"}}}},
				Resources:    corev1.ResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("100m"), corev1.ResourceMemory: resource.MustParse("256Mi")}, Limits: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("2"), corev1.ResourceMemory: resource.MustParse("2Gi")}},
				VolumeMounts: []corev1.VolumeMount{{Name: "state", MountPath: "/data"}, {Name: "tmp", MountPath: "/tmp"}, {Name: "credentials", MountPath: "/credentials", ReadOnly: true}},
			}},
			Volumes: []corev1.Volume{{Name: "state", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: metadata.Name}}}, {Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}}, {Name: "credentials", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: c.CredentialSecret, DefaultMode: ptr(int32(0440))}}}},
		},
	}}}
	if run.Spec.Publication != nil {
		pod := &job.Spec.Template.Spec
		pod.Volumes = append(pod.Volumes, corev1.Volume{Name: "github", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: c.GitHubSecret, DefaultMode: ptr(int32(0440))}}})
		pod.Containers[0].VolumeMounts = append(pod.Containers[0].VolumeMounts, corev1.VolumeMount{Name: "github", MountPath: "/github", ReadOnly: true})
		pod.Containers[0].Env = append(pod.Containers[0].Env, corev1.EnvVar{Name: "WLD_FACTORY_GITHUB_TOKEN_FILE", Value: "/github/token"})
	}
	return job
}
