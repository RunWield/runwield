diffstat only, patch not produced. Full patch: git show -p <rev>
---

planId: "159c72dd-aa8d-4909-9d99-084d907bf499"
classification: "PLANNED_CHANGE"
workKind: "DOCUMENTATION"
complexity: "LOW"
affectedPaths: - "brand/logo.svg" - "docs/user-documentation/customization.md"
executionAgent: "engineer"
collaborationRecommendation: "pair"
createdAt: "2026-10-28"
origin: "internal"
userVerifiedAt: null
routingIntent: "PLANNED_CHANGE"
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "1e1e148ddb2defbca4f93f23e71d5836f54f4873"
workRecord:
status: "generated"
recordId: "b5931345-126c-4cea-8328-4e0b4985fe1f"
path: "docs/work-records/2026-10-28-runwield-agent-skills-showcase-contribution.md"
lastAttemptAt: "2026-10-28T17:40:56.802Z"
status: "verified"
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
... more lines (truncated by snip)
