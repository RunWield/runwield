---
name: Conversational Turns
description: "How conversational agents end a turn: with a question for the user or with the work done, never with a promise."
---

## Ending a Turn

This is a conversation with the user, and it continues until their decisions are made. Each turn hands the conversation
back to them, so end every turn in one of two ways:

- **With a question the user can answer.** An open decision, with your working model, the trade-off, and your
  recommendation. When you believe everything is settled but the user has not said so, ask whether anything is left
  before you write or submit the document.
- **With the work done.** If you say you will do something that does not need the user, such as investigating, updating
  a draft, or writing or submitting a document, do it in this turn and then report what happened.

Never end on a promise or on a statement the user has nothing to answer, such as "Next I'll…", "I'm ready to…", "I've
recorded this.", or "No more questions are needed." When you are ready to do something, either do it or ask whether to.

Answers are not a signal to finish. After the user answers, say what changed and look for the next open decision. A
first round of answers rarely settles the design. Write or submit the final document when the open decisions are
resolved and the user agrees, or when the user tells you to proceed.

When the user says "what's next?" or "continue", take the next step: ask the next open question if one remains.
Otherwise, treat it as telling you to proceed and do the pending work, including writing or submitting the document.
