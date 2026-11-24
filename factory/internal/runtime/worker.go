package runtime

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}
type rpcResponse struct {
	ID     int             `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}
type factoryCapability struct {
	Version int      `json:"version"`
	Loops   []string `json:"loops"`
}
type initializeResult struct {
	ProtocolVersion   int `json:"protocolVersion"`
	AgentCapabilities struct {
		Meta struct {
			Factory factoryCapability `json:"dev.runwield/factory"`
		} `json:"_meta"`
	} `json:"agentCapabilities"`
}

// ExecuteACP speaks the advertised ACP extension over wld's normal stdio server.
// EOF or a missing business receipt is an error, never a completed Router loop.
func ExecuteACP(ctx context.Context, request ExecuteRequest, command string, args ...string) (ExecuteResult, error) {
	var result ExecuteResult
	cmd := exec.CommandContext(ctx, command, args...)
	// wld supervises a runtime child. Kill the entire group, not just its parent.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Dir = request.Cwd
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return result, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return result, err
	}
	cmd.Cancel = func() error {
		_ = stdout.Close()
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	if err := cmd.Start(); err != nil {
		return result, err
	}
	defer func() {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	}()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 4*1024*1024)
	call := func(id int, method string, params json.RawMessage) (json.RawMessage, error) {
		if err := json.NewEncoder(stdin).Encode(rpcRequest{JSONRPC: "2.0", ID: id, Method: method, Params: params}); err != nil {
			return nil, err
		}
		for scanner.Scan() {
			var response rpcResponse
			if err := json.Unmarshal(scanner.Bytes(), &response); err != nil {
				return nil, fmt.Errorf("invalid ACP frame: %w", err)
			}
			if response.ID != id {
				continue
			}
			if response.Error != nil {
				return nil, fmt.Errorf("ACP error %d: %s", response.Error.Code, response.Error.Message)
			}
			if len(response.Result) == 0 {
				return nil, fmt.Errorf("ACP response missing result")
			}
			return response.Result, nil
		}
		if err := scanner.Err(); err != nil {
			return nil, err
		}
		return nil, io.ErrUnexpectedEOF
	}
	initJSON, err := call(1, "initialize", json.RawMessage(`{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"runwield-factory","version":"0.1.0"}}`))
	if err != nil {
		return result, err
	}
	var init initializeResult
	if err := json.Unmarshal(initJSON, &init); err != nil {
		return result, err
	}
	capability := init.AgentCapabilities.Meta.Factory
	if init.ProtocolVersion != 1 || capability.Version != 1 || !slices.Contains(capability.Loops, request.Loop) {
		return result, fmt.Errorf("wld does not advertise factory v1 %s support", request.Loop)
	}
	params, err := json.Marshal(request)
	if err != nil {
		return result, err
	}
	response, err := call(2, "_dev.runwield/factory/execute", params)
	if err != nil {
		return result, err
	}
	if err := json.Unmarshal(response, &result); err != nil {
		return result, err
	}
	return result, validateResult(request, result)
}

func validateResult(request ExecuteRequest, result ExecuteResult) error {
	if result.Version != request.Version || result.OperationID != request.OperationID || result.ProjectID != request.ProjectID || result.Loop != request.Loop || result.Phase != "Completed" {
		return fmt.Errorf("ACP receipt does not match execution identity or completion contract")
	}
	if !slices.Contains([]string{"INQUIRY", "IDEATION", "OPERATION", "QUICK_FIX", "PLANNED_CHANGE", "PROJECT"}, result.Result.RoutingIntent) || !slices.Contains([]string{"LOW", "MEDIUM", "HIGH"}, result.Result.Complexity) || strings.TrimSpace(result.Result.Summary) == "" {
		return fmt.Errorf("ACP receipt has an invalid Router result")
	}
	if classification := result.Result.Classification; classification != "" && (classification != result.Result.RoutingIntent || !slices.Contains([]string{"PLANNED_CHANGE", "PROJECT"}, classification)) {
		return fmt.Errorf("ACP receipt has an inconsistent classification")
	}
	if kind := result.Result.WorkKind; kind != "" && (result.Result.RoutingIntent != "PLANNED_CHANGE" || !slices.Contains([]string{"BUG_FIX", "FEATURE", "REFACTOR", "MAINTENANCE", "DOCUMENTATION"}, kind)) {
		return fmt.Errorf("ACP receipt has an inconsistent work kind")
	}
	if request.Publication != nil {
		if result.Publication == nil {
			return fmt.Errorf("ACP receipt missing GitHub publication")
		}
		id, err := strconv.ParseInt(result.Publication.CommentID, 10, 64)
		u, parseErr := url.Parse(result.Publication.URL)
		expectedPath := "/" + request.Publication.Repository + "/issues/" + strconv.Itoa(request.Publication.IssueNumber)
		if err != nil || id <= 0 || parseErr != nil || u.Scheme != "https" || u.Host != "github.com" || u.User != nil || u.RawQuery != "" || !strings.EqualFold(u.Path, expectedPath) || u.Fragment != "issuecomment-"+result.Publication.CommentID {
			return fmt.Errorf("ACP receipt has invalid GitHub publication")
		}
	} else if result.Publication != nil {
		return fmt.Errorf("unexpected GitHub publication")
	}
	return nil
}

// Seed only the selected provider credentials, never the desktop's entire HOME.
// Keep refreshed credentials on the run volume across process/pod replacement.
func seedCredentials(home string) error {
	data, err := os.ReadFile("/credentials/auth.json")
	if err != nil {
		return err
	}
	return refreshCredentials(home, data)
}

func refreshCredentials(home string, data []byte) error {
	dir := filepath.Join(home, ".wld")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	target := filepath.Join(dir, "auth.json")
	marker := filepath.Join(dir, ".factory-auth-source")
	digest := fmt.Sprintf("%x", sha256.Sum256(data))
	previous, err := os.ReadFile(marker)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if string(previous) == digest {
		if _, err := os.Stat(target); err == nil {
			return nil
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	temporary := target + ".tmp"
	if err := os.WriteFile(temporary, data, 0600); err != nil {
		return err
	}
	if err := os.Rename(temporary, target); err != nil {
		return err
	}
	// A changed Secret repairs credentials; an unchanged Secret preserves wld's OAuth refresh.
	return os.WriteFile(marker, []byte(digest), 0600)
}

func RunWorker(ctx context.Context, c client.Client, namespace, name string) error {
	var step StepExecution
	if err := c.Get(ctx, types.NamespacedName{Namespace: namespace, Name: name}, &step); err != nil {
		return err
	}
	if step.Status.Phase == "Completed" && step.Status.Result != nil {
		return validateResult(step.Spec, *step.Status.Result)
	}
	if err := os.MkdirAll(step.Spec.Cwd, 0700); err != nil {
		return err
	}
	if err := seedCredentials(os.Getenv("HOME")); err != nil {
		return err
	}
	before := step.DeepCopyObject().(*StepExecution)
	step.Status.Phase = "Running"
	if err := c.Status().Patch(ctx, &step, client.MergeFrom(before)); err != nil {
		return err
	}
	attemptCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	result, err := ExecuteACP(attemptCtx, step.Spec, "/usr/local/bin/wld", "--mode", "acp")
	before = step.DeepCopyObject().(*StepExecution)
	if err != nil {
		meta.SetStatusCondition(&step.Status.Conditions, metav1.Condition{Type: "Recovering", Status: metav1.ConditionTrue, Reason: "AttemptInterrupted", Message: "ACP attempt did not produce a validated receipt; worker will retry", ObservedGeneration: step.Generation})
		_ = c.Status().Patch(ctx, &step, client.MergeFrom(before))
		return err
	}
	step.Status.Phase = "Completed"
	step.Status.Result = &result
	meta.SetStatusCondition(&step.Status.Conditions, metav1.Condition{Type: "Recovering", Status: metav1.ConditionFalse, Reason: "ResultPersisted", Message: "Structured Router receipt received", ObservedGeneration: step.Generation})
	if err := c.Status().Patch(ctx, &step, client.MergeFrom(before)); err != nil {
		return err
	}
	fmt.Printf("Router operation %s completed: %s\n", result.OperationID, result.Result.RoutingIntent)
	return nil
}
