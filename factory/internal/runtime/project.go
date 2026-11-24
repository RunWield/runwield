package runtime

import (
	"context"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func projectBindingName(projectID string) string {
	return "factory-project-" + strings.ToLower(projectID)
}

// Bindings are provisioned from Projects by a namespace administrator. Recipe clients can only submit work.
func projectAdmitted(ctx context.Context, reader client.Reader, namespace, projectID string) (bool, error) {
	var binding corev1.ConfigMap
	err := reader.Get(ctx, client.ObjectKey{Namespace: namespace, Name: projectBindingName(projectID)}, &binding)
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return projectID != "" && binding.Immutable != nil && *binding.Immutable && binding.Data["projectId"] == projectID, nil
}
