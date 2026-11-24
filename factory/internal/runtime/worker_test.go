package runtime

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestACPTimeoutStopsSupervisorDescendants(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := ExecuteACP(ctx, ExecuteRequest{Cwd: t.TempDir()}, "/bin/sh", "-c", "sleep 30 & wait")
	if err == nil {
		t.Fatal("timeout must not complete an operation")
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("runtime child held ACP stdout after timeout")
	}
}

func TestCredentialRepairPreservesRefreshUntilSourceChanges(t *testing.T) {
	home := t.TempDir()
	first := []byte(`{"provider":{"key":"first"}}`)
	if err := refreshCredentials(home, first); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, ".wld", "auth.json")
	refreshed := []byte(`{"provider":{"key":"refreshed"}}`)
	if err := os.WriteFile(path, refreshed, 0600); err != nil {
		t.Fatal(err)
	}
	if err := refreshCredentials(home, first); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string(refreshed) {
		t.Fatal("unchanged Secret overwrote refreshed credentials")
	}
	replacement := []byte(`{"provider":{"key":"replacement"}}`)
	if err := refreshCredentials(home, replacement); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string(replacement) {
		t.Fatal("updated Secret did not repair credentials")
	}
}

func TestCapabilityNegotiationIgnoresOtherExtensions(t *testing.T) {
	var result initializeResult
	err := json.Unmarshal([]byte(`{"protocolVersion":1,"agentCapabilities":{"_meta":{"other/capability":true,"dev.runwield/factory":{"version":1,"loops":["router"]}}}}`), &result)
	if err != nil {
		t.Fatal(err)
	}
	if result.AgentCapabilities.Meta.Factory.Version != 1 {
		t.Fatal("lost factory capability")
	}
}
