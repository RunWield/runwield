#!/usr/bin/env bash
# Run from any directory. Requires Bun, Go, Lima, and kubectl on the Mac.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
factory_vm="${FACTORY_VM:-runwield-factory}"
factory_image="${FACTORY_IMAGE:-localhost/runwield-factory:dev}"
factory_build="$repo_root/.ci-cache/factory-image"
if ! limactl list --format '{{.Name}}' | rg -x "$factory_vm" >/dev/null; then
    limactl start --name="$factory_vm" --vm-type=vz --cpus=4 --memory=8 --disk=40 --tty=false template:k3s
else
    limactl start --tty=false "$factory_vm"
fi
export KUBECONFIG="$(limactl list "$factory_vm" --format '{{.Dir}}')/copied-from-guest/kubeconfig.yaml"
"$repo_root/scripts/with-bun.sh" run install:locked
mkdir -p "$factory_build"
"$repo_root/scripts/with-bun.sh" run compile --target aarch64-unknown-linux-gnu --output "$factory_build/wld"
(
    cd factory
    go test ./...
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o "$factory_build/factory" ./cmd/factory
)
cp factory/Containerfile "$factory_build/Containerfile"
limactl shell "$factory_vm" sudo apt-get update
limactl shell "$factory_vm" sudo apt-get install -y podman
limactl shell "$factory_vm" mkdir -p /tmp/runwield-factory-build
limactl copy "$factory_build/wld" "$factory_build/factory" "$factory_build/Containerfile" "$factory_vm:/tmp/runwield-factory-build/"
limactl shell "$factory_vm" sudo podman build -t "$factory_image" -f /tmp/runwield-factory-build/Containerfile /tmp/runwield-factory-build
limactl shell "$factory_vm" sudo rm -f /tmp/runwield-factory-image.tar
limactl shell "$factory_vm" sudo podman save -o /tmp/runwield-factory-image.tar "$factory_image"
limactl shell "$factory_vm" sudo k3s ctr images import /tmp/runwield-factory-image.tar
kubectl apply -f factory/config/crds.json
kubectl apply -f factory/config/tenant.yaml
FACTORY_NAMESPACE=runwield-personal "$repo_root/scripts/with-bun.sh" factory/project.ts
kubectl -n runwield-personal set image deployment/factory-controller "controller=$factory_image"
kubectl -n runwield-personal set env deployment/factory-controller "FACTORY_WORKER_IMAGE=$factory_image"
kubectl -n runwield-personal rollout restart deployment/factory-controller
kubectl -n runwield-personal rollout status deployment/factory-controller --timeout=90s
printf 'Factory deployed. KUBECONFIG=%s\n' "$KUBECONFIG"
printf 'Provision a model credential with ./scripts/with-bun.sh factory/configure-auth.ts, then run the Factory README example with the registered Project ID.\n'
