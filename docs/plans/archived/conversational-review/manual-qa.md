# Manual QA for conversational-review

This checklist is advisory. It does not change RunWield verification status.

<!-- runwield:manual-qa:start child="conversational-review/01-plan-review-conversation" -->

## Plan Review Conversation

Manual verification steps for conversational-review/01-plan-review-conversation

- [ ] In a Workspace Session with Planner, send a question in chat. Confirm that a reply appears, the Plan file has no changes, and Approve works.
- [ ] Add an annotation that asks for a change. Confirm that it appears in the queue, then send it. Confirm that the Plan has a revision and, if its status was `ready_for_work`, its status is `draft`.
- [ ] Submit an answer from a question card. Confirm that the Agent receives only that answer and that the answer is no longer queued.
- [ ] After a reply-only turn, select Approve & Run. Confirm that the approval warning appears, then select “Approve as is” and confirm that the Plan runs.

<!-- runwield:manual-qa:end child="conversational-review/01-plan-review-conversation" -->

<!-- runwield:manual-qa:start child="conversational-review/02-code-review-conversation" -->

## Code Review Conversation

Manual verification steps for conversational-review/02-code-review-conversation

- [ ] In a headed browser, run validation on a small Plan with `codereview: always`. Ask a question in Code Review. Confirm that a reply appears, the diff stays the same, no CI progress appears, and Approve works.
- [ ] Ask for a one-line code change. Confirm that CI runs, then Code Review opens with the new diff and the earlier chat.
- [ ] Agree in chat to remove a Plan requirement. Confirm that the Engineer proposes a Plan Deviation and that the Plan does not change until you confirm it.

<!-- runwield:manual-qa:end child="conversational-review/02-code-review-conversation" -->
