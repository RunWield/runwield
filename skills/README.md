# Installable skills

Published for any coding agent in any project:

```bash
npx skills@latest add gandazgul/runwield
```

| Skill                         | Derived from                       |
| ----------------------------- | ---------------------------------- |
| [`ideator`](ideator/SKILL.md) | `src/agent-definitions/ideator.md` |
| [`guide`](guide/SKILL.md)     | `src/agent-definitions/guide.md`   |
| [`review`](review/SKILL.md)   | nothing — it stands on its own     |

## License

The [MIT License](LICENSE) applies only to the files in `skills/`. It does not apply to any other part of this
repository. All other files keep their existing license terms.

## Where a skill comes from

Most of these are a generic version of one RunWield Agent. The Agent Definition owns the wording, and the skill is the
same document with the parts that only make sense inside RunWield removed: the product name, Agent handoffs, RunWield
tool names, prompt template variables, and RunWield-only artifacts. Nothing else changes. When the skill needs a
capability the Agent calls a tool for, it describes the capability instead of naming the tool, because the installing
project has its own.

A skill may also stand on its own, with no `source` in the baseline. `review` does: it takes the judgment discipline
from the Reviewer prompt but drops the Plan, and adds three review axes and pull-request comments that the workflow
Reviewer has no concept of. Pairing the two would fail this check every time either one was tuned, and force an edit to
a document with no matching idea in it.

## What is tracked

`deno task skills:sync:check` records hashes in `scripts/skill-sync-baseline.json` and fails when they move. It runs in
`deno task ci`.

**Every Markdown file in a skill's directory is tracked**, not just its `SKILL.md`, and the file list is read from the
directory rather than from the baseline. A support file added and never registered is still scanned for leaked wording
and still reported as drift — an explicit list would leave the same hole one level up.

1. Edit whichever file you meant to edit.
2. If the skill has an Agent Definition behind it, carry the change to the other side.
3. `deno task skills:sync:update` to accept the new hashes.

The same check rejects any file in a published skill that still names RunWield, an Agent, or a RunWield tool.

## Keeping our own skills out of an install

The [skills CLI](https://github.com/vercel-labs/skills) offers every skill it finds in a skill container directory,
including the ones under `.agents/skills/` that this repository vendored for its own use. Those opt out with front
matter:

```yaml
metadata:
    internal: true
```

`deno task skills:sync:check` fails when a skill is neither listed in the baseline nor marked internal, so nothing
reaches an installer by accident.
