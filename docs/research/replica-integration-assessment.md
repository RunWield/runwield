# Replica Integration Assessment

**Status:** Research and recommendation only. No integration approved or runtime trial performed.

## Question

Can RunWield integrate GitHub Replica, and would that improve product discovery enough to justify the added work?

## Findings

### Replica is a workflow, not just a generator

Replica combines starter applications, design guidance, a Copilot preview canvas, an optional self-hosted review Hub,
and a GitHub build action. Local prototyping does not require Hub. The documented canvas workflow uses the GitHub
Copilot app and GitHub sign-in. Users can use a Copilot plan or the app's preview bring-your-own-provider option.
Viewing finished prototypes does not require a Copilot subscription.

Sources: [announcement](https://github.blog/changelog/2026-10-28-introducing-replica-an-open-source-ai-prototyping-tool/),
[current README](https://github.com/github/replica#readme).

### Local preview is adaptable, but the canvas is host-specific

The plugin connects ordinary Vite development/preview servers and static HTML servers. Replica also documents a browser
preview fallback for hosts without canvas support. This makes reuse of an existing application plausible; it does not
establish a drop-in canvas integration for RunWield.

The local preview uses a separate browser origin. Original-origin storage is not copied. Only unauthenticated loopback
previews are supported; restrictive script/framing policies and invalid HTTPS certificates can block rendering.
A realistic prototype should therefore use sample data rather than depend on a production login.

Sources: [shared workflow](https://github.com/github/replica/blob/main/starters/shared/REPLICA.md),
[canvas plugin](https://github.com/github/replica/blob/main/.github/extensions/replica-prototype/README.md).

Hub exposes paired-client HTTP routes for connections, prototype metadata, comments, and share links under `/api/canvas`.
These are a possible integration boundary, not evidence of a supported RunWield client. The investigation found no
general prototype-generation SDK or Replica MCP server. Replica's agent writes the application; Replica supplies the
surrounding workflow.

Sources: [Hub routes](https://github.com/github/replica/blob/main/hub/config/routes.rb),
[architecture](https://github.com/github/replica/blob/main/hub/docs/architecture.md).

### The most distinct capabilities are review and learning

Replica supports shared prototype comments, local Pick & polish notes, and controls for prototype scenarios. Its feedback
skills can identify reusable themes and propose guidance changes for explicit approval. The plugin also documents
injection of administrator-accepted Hub learnings into Copilot prompts. These are documented capabilities, not results
verified in RunWield.

Sources: [shared feedback workflow](https://github.com/github/replica/blob/main/starters/shared/REPLICA.md#improve-guidance-from-review-feedback),
[plugin learnings and comments](https://github.com/github/replica/blob/main/.github/extensions/replica-prototype/README.md).

### Shared hosting adds a separate service and artifact lifecycle

Hub needs a Linux server, Docker Compose, persistent storage and backups, an isolated dedicated domain, wildcard DNS and
HTTPS, GitHub App permissions, and a build workflow. It is operated by the adopting organization, not hosted by GitHub.

The starter installer creates an independent Git repository with an initial commit. Hub publication uses committed
prototype branches and retained Builds. This differs from RunWield's current local, ignored, disposable prototypes.
Integration must make publication and retention deliberate rather than silently turn local experiments into shared code.

Sources: [hosting guide](https://github.com/github/replica/blob/main/docs/prototype-environment.md),
[repository setup](https://github.com/github/replica/blob/main/docs/prototype-repository-setup.md),
[publication workflow](https://github.com/github/replica/blob/main/starters/shared/REPLICA.md#publish-the-prototype).

### Licensing allows adaptation; compatibility still needs testing

Replica is MIT-licensed, with separate SIL Open Font License notices for bundled fonts. Its README describes active
maintenance by GitHub staff. The plugin supports release pins; its documentation warns that following main can pick up
changes without a manifest version bump. These facts do not establish a stable RunWield integration contract.

Sources: [README and license links](https://github.com/github/replica#license),
[plugin installation and updates](https://github.com/github/replica/blob/main/.github/extensions/replica-prototype/README.md#install).

### RunWield already covers local design exploration

The existing [prototype Skill](../../src/skills/prototype/SKILL.md) defines disposable prototypes under ignored
`prototypes/<slug>/`, launched with `bun run prototype <slug>`. Its [UI branch](../../src/skills/prototype/UI.md)
already calls for distinct variants, the project's existing browser stack, and reuse of stable design-system components
and tokens. The validated conclusion is retained; prototype files are not promoted directly into production.

Replica would not introduce design-system-aware prototyping from zero. Its potential added value is a more integrated
preview/review experience and reusable learning from design feedback.

## Inference

**Technical feasibility is credible; product value is not yet proved.** Reusing guidance or running Replica beside
RunWield has fewer commitments than embedding its canvas or adopting Hub as a RunWield service.

The learning workflow is the strongest strategic match. However, a second guidance store could conflict with project
PRDs, the current glossary, or approved decisions. A proposed integration should bring selected evidence back for
review, not treat every prototype comment or Replica learning as authoritative RunWield knowledge.

## Recommendation

| Option                                                    | Value                                                     | Cost and recommendation                                                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Adapt selected guidance practices into the existing Skill | Better design context without a new service or host       | Smallest commitment. Consider after a comparison on one real task.                                                                   |
| Use Replica alongside RunWield                            | Try its canvas and feedback workflow without embedding it | Requires a Copilot handoff; Hub adds operations. Best first trial if those capabilities are the goal.                                |
| Embed canvas or Hub into Workspace                        | One integrated experience                                 | Host adaptation, authorization, preview isolation, upgrades, and overlapping artifact ownership. Defer until demand is demonstrated. |

Use one real UI decision for a bounded comparison. Judge time to a useful prototype, component fidelity, ease of giving
feedback, and whether feedback changes a later decision. Test the specific Replica capability that the current Skill
lacks; do not adopt a second platform merely to generate another local page.

A useful target journey is: product question → interactive prototype → selected feedback → reviewed conclusion → PRD
or Plan when appropriate. Prototype review must remain distinct from approval to implement or publish production work.

## Open Questions

- Is the goal better prototyping for the RunWield team, or a native prototyping capability for RunWield users?
- Is the unmet need preview convenience, shared review, design fidelity, or reuse of feedback?
- Can the relevant Replica capability improve a real task without requiring users to change their preferred Agent host?
- What supported external interface can be reused without depending on Copilot-specific canvas internals?

Sources above describe current upstream main and may change. No installation, rendering, API compatibility, deployment,
performance, or security test was performed. This note is not a PRD or an implementation commitment.
