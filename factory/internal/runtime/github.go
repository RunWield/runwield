package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// GitHub is the genuine network boundary; no recipe can change its API host.
type GitHub struct {
	HTTP      *http.Client
	TokenFile string
}
type githubReadFailure struct {
	Status  int
	RetryAt time.Time
}

func (e *githubReadFailure) Error() string {
	return fmt.Sprintf("GitHub read returned HTTP %d; retry scheduled", e.Status)
}
func readRetryAt(response *http.Response) time.Time {
	retry := time.Now().Add(15 * time.Minute)
	if seconds, err := strconv.ParseInt(response.Header.Get("Retry-After"), 10, 64); err == nil && seconds >= 0 && seconds < 365*86400 {
		if after := time.Now().Add(time.Duration(seconds) * time.Second); after.After(retry) {
			retry = after
		}
	} else if after, err := http.ParseTime(response.Header.Get("Retry-After")); err == nil && after.After(retry) {
		retry = after
	}
	if response.Header.Get("X-RateLimit-Remaining") == "0" {
		if seconds, err := strconv.ParseInt(response.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil && time.Unix(seconds, 0).After(retry) {
			retry = time.Unix(seconds, 0)
		}
	}
	return retry
}

type githubRepository struct {
	ID       int64  `json:"id"`
	FullName string `json:"full_name"`
}
type githubLabel struct {
	Name string `json:"name"`
}
type githubIssue struct {
	ID          int64            `json:"id"`
	Number      int              `json:"number"`
	Title       string           `json:"title"`
	Body        string           `json:"body"`
	State       string           `json:"state"`
	Labels      []githubLabel    `json:"labels"`
	PullRequest *json.RawMessage `json:"pull_request"`
}

var repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_.-]+$`)

func NewGitHub(tokenFile string) *GitHub {
	return &GitHub{TokenFile: tokenFile, HTTP: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (g *GitHub) get(ctx context.Context, path string, target interface{}) error {
	token, err := os.ReadFile(g.TokenFile)
	if err != nil {
		return fmt.Errorf("GitHub credential unavailable")
	}
	if strings.TrimSpace(string(token)) == "" {
		return fmt.Errorf("GitHub credential is empty")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com"+path, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "RunWield-Factory")
	response, err := g.HTTP.Do(request)
	if err != nil {
		return fmt.Errorf("GitHub request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return &githubReadFailure{Status: response.StatusCode, RetryAt: readRetryAt(response)}
	}
	return json.NewDecoder(io.LimitReader(response.Body, 16*1024*1024)).Decode(target)
}
func (g *GitHub) verify(ctx context.Context, spec GitHubTriageSpec) error {
	if !repositoryPattern.MatchString(spec.Repository) || strings.HasSuffix(spec.Repository, "/.") || strings.HasSuffix(spec.Repository, "/..") {
		return fmt.Errorf("invalid GitHub repository")
	}
	var repo githubRepository
	if err := g.get(ctx, "/repos/"+spec.Repository, &repo); err != nil {
		return err
	}
	if strconv.FormatInt(repo.ID, 10) != spec.RepositoryID || !strings.EqualFold(repo.FullName, spec.Repository) {
		return fmt.Errorf("GitHub repository identity changed")
	}
	return nil
}
func eligible(issue githubIssue, spec GitHubTriageSpec) bool {
	if issue.ID <= 0 || issue.Number <= 0 || issue.PullRequest != nil || issue.State != "open" {
		return false
	}
	labelFound := false
	for _, label := range issue.Labels {
		if strings.EqualFold(label.Name, spec.Label) {
			labelFound = true
		}
		for _, excluded := range spec.ExcludeLabels {
			if strings.EqualFold(label.Name, excluded) {
				return false
			}
		}
	}
	return labelFound
}
func (g *GitHub) selectIssues(ctx context.Context, spec GitHubTriageSpec, claimed map[string]bool) ([]SelectedIssue, error) {
	if err := g.verify(ctx, spec); err != nil {
		return nil, err
	}
	limit := 1
	if spec.Mode == "batch" {
		limit = 10
	} else if spec.Mode != "next" {
		return nil, fmt.Errorf("unsupported admission mode")
	}
	selected := []SelectedIssue{}
	// Bound a wake's work. Hitting the bound is a retryable error, not an empty result.
	for page := 1; page <= 100; page++ {
		query := url.Values{"state": {"open"}, "labels": {spec.Label}, "sort": {"created"}, "direction": {"asc"}, "per_page": {"100"}, "page": {strconv.Itoa(page)}}
		var issues []githubIssue
		if err := g.get(ctx, "/repos/"+spec.Repository+"/issues?"+query.Encode(), &issues); err != nil {
			return nil, err
		}
		for _, issue := range issues {
			id := strconv.FormatInt(issue.ID, 10)
			name := issueRunName(spec.RepositoryID, id)
			if !eligible(issue, spec) || claimed[name] {
				continue
			}
			selected = append(selected, SelectedIssue{ID: id, Number: issue.Number, RunName: name})
			claimed[name] = true
			if len(selected) == limit {
				return selected, nil
			}
		}
		if len(issues) < 100 {
			return selected, nil
		}
	}
	return nil, fmt.Errorf("GitHub selection exceeded 100 pages")
}
func (g *GitHub) issue(ctx context.Context, spec GitHubTriageSpec, selected SelectedIssue) (githubIssue, error) {
	var issue githubIssue
	err := g.get(ctx, "/repos/"+spec.Repository+"/issues/"+strconv.Itoa(selected.Number), &issue)
	if err == nil && (strconv.FormatInt(issue.ID, 10) != selected.ID || issue.Number != selected.Number || issue.PullRequest != nil) {
		err = fmt.Errorf("GitHub issue identity changed")
	}
	return issue, err
}
