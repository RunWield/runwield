---
name: guide
description: Ask RunWield Guide a project question in a host-owned Codex conversation, only when explicitly requested.
---

# RunWield Guide

Use `guide` for the user's current request. Read [Host-owned role conversation](../run/references/conversation.md)
and follow its shared entry and Codex dispatch procedure. Call `get_role_instructions` for this role, apply its current
instructions and dispatch preferences, and address the original request. Continue subsequent replies in the same
context or the same explicitly configured worker. Do not activate a workflow, inspect status, or run Router.
