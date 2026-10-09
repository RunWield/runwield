# Collaborative Planning — PRD

**Scope:** Self-hosted collaborative Plan review. **Author:** Gandazgul

---

## 1. Objective

Enable RunWield users to share Plans with teammates and stakeholders, collect structured encrypted feedback in a Shared
Space, and iteratively refine Plans through Revision cycles without requiring accounts, GitHub, or local tooling for
reviewers.

## 2. Problem Statement

RunWield is local-first. Users can create durable markdown Plans locally, but team review needs:

- readable browser access for technical and non-technical stakeholders;
- comments attached to specific Plan text or to the whole Revision;
- one stable link that survives Revision updates;
- maintainer handoff without accounts; and
- server-side privacy where semantic Plan/comment content remains ciphertext.

Chat-based feedback fragments long-form review. Immutable snapshot links fragment discussion across multiple URLs. A
Shared Space keeps review and revisions together while preserving the local Plan lifecycle.

## 3. Product Experience

- A Shared Space gives reviewers one stable link to successive Plan Revisions. Comments belong to the Revision they
  discuss and do not silently carry forward.
- Reviewers can read, comment on selected text or the whole Revision, resolve and reopen comments, and switch Revisions
  in a browser without accounts or local tools.
- A maintainer can share a Plan, collect feedback, pull it into Planner or Architect, revise locally, and publish the
  next Revision. Maintainer access can be handed to another person without an account system.
- While shared, the Plan has one agreed review version. Local editing and publishing must not silently overwrite newer
  shared work. Unsharing returns it to ordinary local use.
- The server cannot read Plan bodies, comments, display names, or annotations. Reviewer and maintainer links confer
  access; users need clear guidance on which link to share and how to protect it.
- V1 browser actions cover review. Publishing Revisions and ending sharing remain CLI actions.

## 4. CLI Experience

| Command                                              | User outcome                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wld plans share <plan-name-or-id>`                  | Start shared review and receive reviewer and maintainer links. Show expiry when enabled.                                                                |
| `wld plans pull <maintainer-url-or-plan-name-or-id>` | Receive the latest Revision and comments, take over maintenance when given a maintainer link, and continue with Planner or Architect.                   |
| `wld plans push <plan-name-or-id>`                   | Publish the accepted local changes as the next Revision at the same link.                                                                               |
| `wld plans unshare <plan-name-or-id>`                | End sharing, delete the remote content, and return the local Plan to independent use. Explain recovery when the remote content has already disappeared. |

## 5. Delivery

V1 is a self-hosted, source-built package. Operators need setup, public-access, abuse-control, optional inactivity
expiry, and backup/restore guidance. Users must see when a Shared Space will expire. Hosting must preserve private
content and accountless review.

Hosted RunWield Workspace, Cloudflare deployment, and published container images remain follow-up work.

Architecture is documented in [ADR-008](../adr/008-remote-canonical-collaborative-shared-spaces.md). API, deployment,
storage, and operational instructions belong in the
[collaboration documentation](../user-documentation/collaboration.md).

## 6. Audience

Plan maintainers and technical or non-technical reviewers who need asynchronous feedback without joining another
service.

## 7. Risks and Mitigations

- Forwarding a privileged link can give unintended access. Clearly distinguish reviewer and maintainer links.
- Public hosting can attract abuse. Give operators practical access, rate-limit, and retention guidance.
- Local and shared changes can diverge. Make the version being reviewed and the next publishing action clear.

## 8. Out of Scope for Current V1

- User accounts or full role-based access control.
- Built-in public-instance creation authentication.
- RunWield-managed TLS or certificate renewal.
- Real-time collaborative editing or browser Plan body editing.
- Browser-side push, close, or destructive unshare/delete controls.
- Notifications.
- Attachments in comments.
- Diff view between Revisions.
- Hosted SaaS or Cloudflare/D1 deployment.
- Published signed/versioned multi-architecture container images.

## 9. Success Metrics

- A maintainer can self-host, share a Plan, receive comments from at least two reviewers, revise through Planner or
  Architect, publish a new Revision at the same link, and unshare.
- Semantic Plan and comment content is unreadable to the hosting service.
- Operators can expose a trial deployment with abuse controls and optional inactivity expiry without adding reviewer
  accounts or requiring RunWield to manage certificates.
- Following the backup/restore guide recovers access to the shared Revisions and comments.

## 10. Future Work

- Creation credentials or another abuse-resistant public creation model with CLI storage, rotation, and recovery UX.
- Hosted RunWield Workspace and Cloudflare/D1 deployment.
- Published signed container images and release provenance.
- Notifications and activity/audit feeds.
- Browser diff view between Revisions.
- Optional export/summary view for closed Shared Spaces.
