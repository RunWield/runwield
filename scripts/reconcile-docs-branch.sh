#!/usr/bin/env bash
set -euo pipefail

tag=${1:?Stable tag is required}
bootstrap=${2:-false}
source_sha=${3:-${GITHUB_SHA:-HEAD}}

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git fetch origin "refs/tags/$tag:refs/tags/$tag"
if git ls-remote --exit-code --heads origin docs/stable >/dev/null 2>&1; then
  git fetch origin docs/stable:refs/remotes/origin/docs/stable
  read -r previous_tag previous_source_ref < <(
    git show refs/remotes/origin/docs/stable:docs-site/release.json |
      deno eval '
const release = JSON.parse(await new Response(Deno.stdin.readable).text());
if (typeof release.version !== "string" || !/^v\d+\.\d+\.\d+$/.test(release.version)) {
  throw new Error("docs/stable has no valid Stable version");
}
if (typeof release.sourceRef !== "string" || !/^[0-9a-f]{40}$/.test(release.sourceRef)) {
  throw new Error("docs/stable has no valid source commit");
}
console.log(`${release.version} ${release.sourceRef}`);
'
  )
  git fetch origin "refs/tags/$previous_tag:refs/tags/$previous_tag"
  git merge-base --is-ancestor "$previous_tag" "$previous_source_ref"
  git merge-base --is-ancestor "$previous_source_ref" refs/remotes/origin/docs/stable
  git checkout -B docs-update "$tag"
  merge_args=(--write-tree --name-only --merge-base "$previous_source_ref" "$tag" refs/remotes/origin/docs/stable)
  if merge_output=$(git merge-tree "${merge_args[@]}"); then
    merge_tree=$(printf '%s\n' "$merge_output" | head -n 1)
  else
    conflict_paths=$(printf '%s\n' "$merge_output" | sed -n '2,/^$/p' | sed '/^$/d')
    if [[ "$conflict_paths" != "docs-site/release.json" ]]; then
      printf '%s\n' "$merge_output" >&2
      exit 1
    fi
    merge_tree=$(git merge-tree --write-tree --name-only --merge-base "$previous_source_ref" -X ours "$tag" refs/remotes/origin/docs/stable | head -n 1)
  fi
  release_parent=$(git rev-parse "$tag^{commit}")
  docs_parent=$(git rev-parse refs/remotes/origin/docs/stable)
  merge_commit=$(printf 'Merge docs/stable into %s\n' "$tag" | git commit-tree "$merge_tree" -p "$release_parent" -p "$docs_parent")
  git reset --hard "$merge_commit"
else
  test "$bootstrap" = "true" || {
    echo "docs/stable does not exist; run the manual workflow with bootstrap=true" >&2
    exit 1
  }
  git checkout -B docs-bootstrap "$tag"
  git checkout "$source_sha" -- \
    .github/workflows/docs.yml .gitignore deno.json deno.lock \
    docs/user-documentation/index.md docs-site scripts/public-docs.ts scripts/check-public-docs.ts \
    scripts/docs-dev.ts scripts/public-docs.test.ts scripts/docs-workflow.test.ts \
    scripts/docs-branch-integration.test.ts scripts/reconcile-docs-branch.sh \
    scripts/verify-docs-source.ts
fi

if ! git diff --cached --quiet; then
  git commit -m "docs: prepare $tag"
fi
source_ref=$(git rev-parse HEAD)
deno eval '
const [tag, sourceRef] = Deno.args;
const path = "docs-site/release.json";
const release = JSON.parse(await Deno.readTextFile(path));
release.version = tag;
release.sourceRef = sourceRef;
release.releaseUrl = `https://github.com/gandazgul/runwield/releases/tag/${encodeURIComponent(tag)}`;
await Deno.writeTextFile(path, `${JSON.stringify(release, null, 2)}\n`);
' "$tag" "$source_ref"

git add docs-site/release.json
if ! git diff --cached --quiet; then
  git commit -m "docs: publish $tag manual"
fi
git push origin HEAD:docs/stable
