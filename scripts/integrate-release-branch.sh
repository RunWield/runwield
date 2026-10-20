#!/usr/bin/env bash
set -euo pipefail

tag=${1:?Stable tag is required}
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Expected a Stable tag" >&2; exit 1; }
branch="release/$tag"
recover() {
  echo "Release Branch integration failed. Keep $branch and resolve the merge manually:" >&2
  echo "git fetch origin main $branch" >&2
  echo "git switch main && git merge --no-ff origin/$branch" >&2
  echo "# Resolve conflicts without dropping release fixes, then commit and push main." >&2
  echo "git push origin main && git fetch origin main $branch" >&2
  echo "git merge-base --is-ancestor origin/$branch origin/main" >&2
  echo "# Only after that check succeeds: git push origin --delete $branch" >&2
}
trap recover ERR

# A missing branch is normal for direct Stable, legacy series, and retries.
remote=$(git ls-remote --heads origin "refs/heads/$branch")
if [ -z "$remote" ]; then
  echo "No remote $branch; skipping integration."
  exit 0
fi
git fetch origin "refs/heads/main:refs/remotes/origin/main" "refs/heads/$branch:refs/remotes/origin/$branch"
tip=$(git rev-parse "refs/remotes/origin/$branch")
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git checkout --detach origin/main
if ! git merge-base --is-ancestor "$tip" HEAD; then
  git merge --no-ff "$tip" -m "Merge $branch after $tag publication"
  git push origin HEAD:refs/heads/main
fi
git fetch origin "refs/heads/main:refs/remotes/origin/main"
git merge-base --is-ancestor "$tip" origin/main
# A fix pushed during integration must not be lost. The lease protects deletion
# even when the branch changes after the ancestry check.
git push --force-with-lease="refs/heads/$branch:$tip" origin ":refs/heads/$branch"
