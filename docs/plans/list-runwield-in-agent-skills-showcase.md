---
planId: "159c72dd-aa8d-4909-9d99-084d907bf499"
classification: "PLANNED_CHANGE"
workKind: "DOCUMENTATION"
complexity: "LOW"
affectedPaths:
    - "brand/logo.svg"
    - "docs/user-documentation/customization.md"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-10-28"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
deliveryBranch: "main"
status: "reviewed"
validatedCommit: "1e1e148ddb2defbca4f93f23e71d5836f54f4873"
workRecord:
    status: "generated"
    recordId: "b5931345-126c-4cea-8328-4e0b4985fe1f"
    path: "docs/work-records/2026-10-28-runwield-agent-skills-showcase-contribution.md"
    lastAttemptAt: "2026-10-28T17:40:56.802Z"
---

# List RunWield in the Agent Skills Client Showcase

## Context

The Agent Skills project lists compatible products on its Client Showcase (`https://agentskills.io/clients`) and in the
logo carousel on its home page. RunWield finds and runs Agent Skills today, but it is not listed. No RunWield pull
request (PR) is open in `agentskills/agentskills`.

The contribution guide (`CONTRIBUTING.md`, section "Ecosystem Listings & Logo Requests") requires:

1. **Logo files**: SVG preferred. Light and dark variants in `docs/images/logos/<name>/`.
2. **A client entry** in the `clients` array in `docs/snippets/clients.jsx`.
3. **Product information in the PR description**: product name, product link, and a link to documentation for the
   Skills implementation.
4. **AI-assistance disclosure** in the PR, with the extent of AI use. The maintainers close PRs that do not disclose.

The product must be public and must discover and run Skills today. RunWield meets this. It is MIT-licensed and public
at `https://github.com/RunWield/runwield`. The current release is v0.14.2. The Skills behavior is documented at
`https://docs.runwield.dev/customization/` (section "Skills").

Recent showcase PRs use the title `docs: add <Product> to client showcase`. PR #626 (Woven) is the best format
reference. Its description has these sections: Summary, Product information, How <Product> implements Skills, Logo, and
AI disclosure.

All of this work happens in an external repository. No PRD or domain-language change applies.

## Objective

An open PR in `agentskills/agentskills` adds RunWield to the Client Showcase. The PR follows the contribution guide and
the format of recent showcase PRs, and it is ready for maintainer review.

## Approach

Fork, branch, add two logo files and one client entry, check the result in a local Mintlify preview, then open the PR.

```text
gh repo fork agentskills/agentskills --org RunWield --clone=false
git clone git@github.com:RunWield/agentskills.git  <temp dir outside the RunWield worktree>
git checkout -b add-runwield
  add docs/images/logos/runwield/runwield-logo-light.svg
  add docs/images/logos/runwield/runwield-logo-dark.svg
  append RunWield entry to docs/snippets/clients.jsx
mint dev   -> check /clients and / in light and dark mode
git push -> gh pr create -R agentskills/agentskills --head RunWield:add-runwield
```

Decisions from planning:

- **Logo colors**: light pages use a deep slate `#0B1020` mark. Dark pages use the brand mint `#85CBBF` mark. Brand
  mint on white has low contrast (about 1.8:1), and other clients also use a dark mark for light pages.
- **Logo geometry**: copy the exact W path and cursor square from `brand/logo.svg`. Remove the `<animate>` blink
  element and the editor `id` attributes. `brand/brand-identity.md` forbids redrawing or simplifying the mark.
- **Fork owner**: a fork in the RunWield GitHub organization. The PR is opened by the `gandazgul` account.

> [!NOTE]
> **The RunWield worktree has no source change**
>
> The deliverable is a PR in another repository. Do the external clone outside the RunWield execution worktree. Do not
> commit agentskills files into the RunWield repository.

## Expected Change Surface

This list is guidance, not an allowlist. Verify the real footprint during implementation and change whatever the
Implementation Steps need. Stop and report only when discovery changes approved intent: for example, the maintainers'
format changed, the contribution guide adds a requirement, or a RunWield PR already exists.

All paths below are in the `RunWield/agentskills` fork, branch `add-runwield`:

```diff
 docs/
 ├── images/logos/
+│   └── runwield/
+│       ├── runwield-logo-light.svg   # slate #0B1020 mark for light pages
+│       └── runwield-logo-dark.svg    # mint #85CBBF mark for dark pages
 └── snippets/
     └── clients.jsx                   # one new RunWield entry at the end of the array
```

RunWield files are read-only sources:

- `brand/logo.svg` — the exact logo geometry to copy.
- `docs/user-documentation/customization.md` — the Skills facts for the PR description.

## Reuse Opportunities

- `brand/logo.svg` — the canonical W path and cursor square, with the `translate(10,10)` group transform and the
  `0 0 140 110` viewBox.
- PR #626 (`https://github.com/agentskills/agentskills/pull/626`) — the PR description structure.
- Existing entries in `docs/snippets/clients.jsx` (for example "Deep Code" and "Hermes Agent") — the field order and
  the optional `scale` and `sourceCodeUrl` fields.

## Implementation Steps

- The fork `RunWield/agentskills` exists, and branch `add-runwield` starts from the current `agentskills/agentskills`
  `main`.
- `docs/images/logos/runwield/runwield-logo-light.svg` and `runwield-logo-dark.svg` exist. Each one contains the exact
  path data and rectangle from `brand/logo.svg`, in the same viewBox and group transform. Neither file contains an
  `<animate>` element. The light file fills the mark with `#0B1020`. The dark file fills the mark with `#85CBBF`.
- `docs/snippets/clients.jsx` ends with this entry. All other entries are unchanged:

    ```js
    {
      name: "RunWield",
      description: "RunWield is an open-source coding agent harness that plans each change for your review, builds it with specialized agents, and checks the result against the plan before it calls the work done. It runs locally and works with any model.",
      url: "https://runwield.dev/",
      lightSrc: "/images/logos/runwield/runwield-logo-light.svg",
      darkSrc: "/images/logos/runwield/runwield-logo-dark.svg",
      scale: 0.6,
      instructionsUrl: "https://docs.runwield.dev/customization/#skills",
      sourceCodeUrl: "https://github.com/RunWield/runwield",
    },
    ```

    Keep `instructionsUrl` with `#skills` only if that anchor goes to the Skills section on the live page. Otherwise use
    `https://docs.runwield.dev/customization/`. Adjust `scale` only if the local preview shows the mark too large or too
    small next to other square marks.

- The local Mintlify preview (`cd docs && npx mint dev`) shows a RunWield card on `/clients` with the logo, name,
  description, "Setup instructions" link, and "Source code" link. The RunWield logo shows in the home page carousel.
  The logo is clearly visible in both light and dark mode.
- An open PR in `agentskills/agentskills` has the title `docs: add RunWield to client showcase` and comes from
  `RunWield:add-runwield`. The branch has one commit with the same message. The PR description has these sections:
    - **Summary**: add RunWield to the showcase, add light and dark logos, add the `clients.jsx` entry.
    - **Product information**: product link `https://runwield.dev/`, Skills documentation link, source code link,
      availability (public, MIT, installed with `curl -fsSL https://raw.githubusercontent.com/RunWield/runwield/main/install.sh | bash`,
      current release v0.14.2, no account needed).
    - **How RunWield implements Skills**: RunWield looks for `SKILL.md` folders in `.wld/skills/` and `.agents/skills/`
      in the project, then in `~/.wld/skills/` and `~/.agents/skills/`, then in its bundled Skills. The first match wins.
      Agents see each Skill's name and description and load the full `SKILL.md` when a task needs it. Users can also run
      a Skill directly with `/skill:<name>`. The `enableExternalSkills` setting turns off the `.agents/skills/` folders.
      State these facts only as `docs/user-documentation/customization.md` documents them.
    - **Logo**: SVG, exact brand geometry, slate `#0B1020` mark for light pages and mint `#85CBBF` mark for dark pages,
      no wordmark, `scale: 0.6`, open to adjustment.
    - **AI disclosure**: the PR was prepared with RunWield (an AI coding agent). It drafted the entry, the description,
      and the two logo files from the existing brand SVG. Carlos (gandazgul) reviewed the text, links, and logos.
- The PR URL is reported to the user.

## Verification Plan

- Automated: from the fork checkout, `git diff --stat origin/main...add-runwield` lists exactly the two logo files and
  `docs/snippets/clients.jsx`.
- Automated: `diff` of the `d=` path data and `<rect>` attributes between `brand/logo.svg` and each new SVG shows no
  difference. `grep -c "<animate" docs/images/logos/runwield/*.svg` returns 0 for both files.
- Automated: `curl -sL -o /dev/null -w "%{http_code}"` returns 200 for `https://runwield.dev/`,
  `https://docs.runwield.dev/customization/`, and `https://github.com/RunWield/runwield`.
- Manual (browser): with `cd docs && npx mint dev`, use agent-browser on `http://localhost:3000/clients` and
  `http://localhost:3000/` in light and dark mode. Capture screenshots of the RunWield card and the carousel. The
  screenshots go in the PR description only if the user wants them; they are always shown to the user.
- Manual: `gh pr view <number> -R agentskills/agentskills` shows the PR open, from `RunWield:add-runwield`, with all five
  description sections and the AI disclosure.
- Expected result: a reviewer can verify the listing from the PR alone: logo, entry, product link, Skills
  documentation, and disclosure.

## Edge Cases & Considerations

- **Organization fork permission**: `gh repo fork --org RunWield` needs fork rights in the organization. If it fails,
  stop and ask the user before falling back to a personal fork.
- **Upstream changes**: if `clients.jsx` or the contribution guide changed after planning, follow the current file and
  guide, and report any new requirement.
- **Mintlify preview**: Mintlify blocks preview builds for fork PRs until a maintainer approves them. The local preview
  is the evidence before review.
- **Anchor link**: the live docs page may not expose a `#skills` anchor. Check it before using it.
- **Description claims**: the description must not claim capabilities the docs do not show. Do not mention Connect,
  Workspace SaaS, or unreleased features.
- **Assumption**: the description text above is a reviewable draft. The user can change the wording during Plan review.
