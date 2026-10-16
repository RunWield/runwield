#!/usr/bin/env bash
set -euo pipefail

tag=${1:?Stable tag is required}
bootstrap=${2:-false}
source_sha=${3:-${GITHUB_SHA:-HEAD}}

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git fetch origin "refs/tags/$tag:refs/tags/$tag"
release_parent=$(git rev-parse "$tag^{commit}")
parents=(-p "$release_parent")
if git ls-remote --exit-code --heads origin docs/stable >/dev/null 2>&1; then
  git fetch origin docs/stable:refs/remotes/origin/docs/stable
  docs_parent=$(git rev-parse refs/remotes/origin/docs/stable)
  read -r previous_tag previous_source_ref < <(
    git show "$docs_parent":docs-site/release.json |
      bun -e '
const release = JSON.parse((await import("node:fs")).readFileSync(0, "utf8"));
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
  previous_release=$(git rev-parse "$previous_tag^{commit}")
  git merge-base --is-ancestor "$previous_release" "$previous_source_ref"
  git merge-base --is-ancestor "$previous_source_ref" "$docs_parent"
  previous_base=$previous_source_ref
  # New metadata records the released product tree. Its delta against the docs
  # tip includes corrections carried through earlier publications, not only the
  # corrections made since the last merge. Legacy metadata keeps its old base.
  if [[ "$previous_tag" == "$tag" ]]; then
    # Keep corrections made after publication, including the old two-commit form.
    git checkout -B docs-update "$docs_parent" >&2
    printf '%s\n' "$docs_parent"
    exit 0
  fi
  git checkout -B docs-update "$release_parent" >&2
  merge_args=(--write-tree --name-only --merge-base "$previous_base" "$release_parent" "$docs_parent")
  if merge_output=$(git merge-tree "${merge_args[@]}"); then
    merge_tree=$(printf '%s\n' "$merge_output" | head -n 1)
  else
    conflict_paths=$(printf '%s\n' "$merge_output" | sed -n '2,/^$/p' | sed '/^$/d')
    if [[ "$conflict_paths" != "docs-site/release.json" ]]; then
      printf '%s\n' "$merge_output" >&2
      exit 1
    fi
    merge_tree=$(git merge-tree --write-tree --name-only --merge-base "$previous_base" -X ours "$release_parent" "$docs_parent" | head -n 1)
  fi
  git read-tree --reset -u "$merge_tree"
  parents+=(-p "$docs_parent")
else
  test "$bootstrap" = "true" || {
    echo "docs/stable does not exist; prepare it with reconcile-docs-branch.sh <stable-tag> true <site-support-commit>" >&2
    exit 1
  }
  git checkout -B docs-bootstrap "$release_parent" >&2
  git checkout "$source_sha" -- \
    .github/workflows/docs.yml .gitignore \
    docs/user-documentation/index.md docs-site scripts/public-docs.ts scripts/check-public-docs.ts \
    scripts/docs-dev.ts scripts/public-docs.test.ts scripts/docs-workflow.test.ts \
    scripts/docs-branch-integration.test.ts scripts/reconcile-docs-branch.sh \
    scripts/verify-docs-source.ts
fi

bun -e '
const [tag, sourceRef] = process.argv.slice(1);
const path = "docs-site/release.json";
const release = JSON.parse(await Bun.file(path).text());
release.version = tag;
release.sourceRef = sourceRef;
release.releaseUrl = `https://github.com/gandazgul/runwield/releases/tag/${encodeURIComponent(tag)}`;
await Bun.write(path, `${JSON.stringify(release, null, 2)}\n`);
' "$tag" "$release_parent"

git add docs-site/release.json
publication_tree=$(git write-tree)
publication_commit=$(printf 'docs: publish %s manual\n' "$tag" | git commit-tree "$publication_tree" "${parents[@]}")
git reset --hard "$publication_commit" >&2
printf '%s\n' "$publication_commit"
