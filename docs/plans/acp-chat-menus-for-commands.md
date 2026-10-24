diffstat only, patch not produced. Full patch: git show -p <rev>
---

planId: "ed3d4357-895e-4968-ad80-1ae3cfea82f0"
classification: "PLANNED_CHANGE"
workKind: "FEATURE"
complexity: "HIGH"
affectedPaths: - "src/acp/server.js" - "src/acp/interaction-mapper.js" - "src/acp/interview-chat.ts" - "src/shared/session/runtime/lifecycle-loading.ts" - "src/acp/server.test.js" - "src/acp/interaction-mapper.test.js" - "docs/prd/runwield-acp-protocol-prd.md" - "docs/adr/010-session-runtime-sibling-adapters-and-acp.md" - "docs/acp-implementation-details.md" - "docs/domain-language.md"
executionAgent: "engineer"
collaborationRecommendation: "autonomous"
createdAt: "2026-10-18"
origin: "internal"
userVerifiedAt: null
targetBranch: "main"
deliveryBranch: "main"
validatedCommit: "d36e84d37b55a585e5b763f3b74a3d5f5c1d24ea"
workRecord:
status: "generated"
recordId: "4539f59e-2074-4614-9e77-548b593621df"
path: "docs/work-records/2026-10-18-acp-chat-menus-for-commands-and-workflow-questions.md"
lastAttemptAt: "2026-10-18T23:19:32.760Z"
status: "verified"
---

# ACP Chat Menus for Commands

## Context

`/load-plan` is already registered for ACP, and it already skips the terminal-only directory prompts on ACP. It still
does not work end to end from Discord through OpenAB. The problem is how its menus are shown.
Every menu in a built-in command goes through `runtime.requestInteraction`. The ACP adapter
(`createAcpInteractionAdapter` in `src/acp/interaction-mapper.js`) then shows it in one of two ways:

| Client                                                                                                                 | Command menus today                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Supports ACP forms (JetBrains, Air)                                                                                    | Native `elicitation/create` form. This works.                                 |
| No forms (OpenAB in Discord, upstream)                                                                                 | `Open this RunWield question to continue: http://127.0.0.1:…` (loopback page) |
| A loopback link only works at the machine that runs `wld acp`. From a phone, `/load-plan` stops at its first menu. The |
| same is true for `/agent`, `/model`, and every other command picker, and for select, text, and approval questions that |
| an Agent workflow asks outside `user_interview`.                                                                       |
| There is a second gap. `dispatchAcpBuiltinCommand` holds one ACP request open for the whole command. When `/load-plan` |
| ... more lines (truncated by snip)                                                                                     |
