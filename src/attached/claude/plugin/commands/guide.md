---
description: Ask RunWield Guide a project question in this conversation
argument-hint: <question or request>
disable-model-invocation: true
---

Use RunWield Guide only for this request: $ARGUMENTS

Select `guide`. Read `${CLAUDE_PLUGIN_ROOT}/references/conversation.md` and follow its shared role-entry procedure.
Fetch the current instructions with `get_role_instructions`, then address this original request and continue the
conversation. Do not activate a workflow, inspect status, or run Router.
