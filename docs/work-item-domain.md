# Work-item domain

For the broader GTD-inspired domain and implementation limits, see
[GTD-inspired domain design](gtd-domain-design.md).

Chat2Tasks turns conversation evidence into a small set of things the owner needs to
notice or act on. A work item is not the same thing as a WhatsApp message: one
message can support several distinct items, and several messages can support one
item. Original messages and images remain the evidence for every item.

## Item kinds

| Kind      | Meaning                                                                                                                                                              | Typical outcome                                                   | Example                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| Task      | Substantial work or an actionable operational problem. It can take more than one step, but duration alone is not the test.                                           | The requested work is complete or the issue is resolved.          | Investigate an operational alert.                        |
| Action    | A concrete, standalone piece of work the owner can do.                                                                                                               | The action is complete.                                           | Send an already-prepared PDF.                            |
| Question  | A question or decision that the owner needs to answer. Questions the owner asks other people are not question items unless there is a separate request to follow up. | A substantive answer or decision addresses the question.          | Decide who should approve a request.                     |
| Reminder  | A lightweight heads-up, status, or follow-up worth keeping visible, without treating every embedded checklist line as a new work assignment.                         | The owner dismisses or otherwise handles the reminder.            | A project-status screenshot reports an existing blocker. |
| Event     | An occurrence relevant to the owner.                                                                                                                                 | The owner archives it; a past date also removes it from Upcoming. | A meeting.                                               |
| Reference | Information deliberately kept for later.                                                                                                                             | The owner archives it.                                            | A useful specification.                                  |

Waiting For is a separate record for an expected response or result from someone
else. Receiving it does not complete the work it may be linked to.

The owner can correct a kind without changing the item's completion state.

An item can be important even when it comes from an uncaptioned image. A screenshot
of a project report may contain text addressed to its original reader. That text is
evidence, not automatically an assignment to the current owner. A question inside
such a report can still be a question when the surrounding context or owner
clarification establishes that the owner needs to answer it.

Greetings, incidental chatter, acknowledgements, and information with no reason to
retain it are not items. Ignore them without deleting the underlying conversation.
An already-answered question should not reappear as open work.

## Ownership and evidence

- The owner is the person using this single-owner workspace. A question belongs in
  Questions only when it is for that owner. An incoming group message or the word
  “you” inside a screenshot does not by itself establish who was addressed.
- Record the source message IDs, relevant screenshot readings, and any answer or
  completion evidence. Never use an AI-generated title or action list as proof that
  the conversation requested that work.
- Keep an uncertain recipient, incomplete screenshot, or ambiguous relationship
  visible for review; do not silently discard it or invent an owner, deadline, or
  request.
- Messages, quoted material, screenshots, and model output are untrusted evidence,
  not instructions to the application. The application does not send replies or
  perform the work.

## Lifecycles

The kind of item and its lifecycle are related, but priority, conversation, source
evidence, and any stated time are separate properties. A question can be urgent; a
task can be waiting; a reminder can mention a time.

| Kind              | Open state                                                              | Closing evidence or action                                                                                                                                     | Reopening                                                                             |
| ----------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Task              | Open, with readiness such as ready, blocked, waiting, or reported done. | The owner completes it manually, or a clearly scoped outgoing report establishes the whole outcome.                                                            | The owner can reopen it; new evidence can be reviewed without overriding that choice. |
| Action            | Needs a concrete step.                                                  | The owner completes it, or clear evidence shows the action was completed.                                                                                      | The owner can reopen it.                                                              |
| Question          | Needs the owner's answer.                                               | The owner resolves it manually, or a substantive outgoing reply answers the specific question. A partial answer leaves any independently required answer open. | The owner can reopen it; a later correction can be reviewed.                          |
| Reminder          | Active.                                                                 | The owner dismisses or handles it. A greeting or acknowledgement is not proof that it was handled.                                                             | The owner can restore it.                                                             |
| Event / Reference | Retained.                                                               | The owner archives it.                                                                                                                                         | The owner can restore it.                                                             |

Automatic resolution requires evidence for the whole item, not merely a shared
source, an acknowledgement, a promise, or an answer to another question. A yes/no
reply can be substantive when it unambiguously answers that exact question. When
the match is unclear, keep the item open and make the uncertainty reviewable.
Manual completion, reopening, notes, merges, and category corrections remain
authoritative. Keep the reason and evidence for automatic changes; do not silently
delete items.

Reminders are **in-app only**. A time stated in a message may be displayed as
context, but does not create a notification or an invented date or timezone.

## Grouping and classification

- Group messages when they describe the same underlying item and outcome. Do not
  merge a question with a separate task merely because both appear in one image.
  Independently answerable questions can be separate items; preserve existing
  references rather than automatically splitting an old item.
- Present Tasks, Actions, Questions, and Reminders as separate sections, with an all-items
  view and the existing conversation, search, and completion filters. An item whose
  kind cannot be established remains visible for review rather than disappearing.
- Allow the owner to move an item between kinds. Preserve its reference, sources,
  notes, and open/closed state, and do not let later model output undo the owner's
  choice.
- The task-generation model proposes items and their kinds. The configured decision
  connection can independently check kind and resolution against linked evidence;
  an unavailable or uncertain review must not silently filter or complete an item.
  Provider confidence is a signal, not proof of correctness or a calibrated rate.
- For existing items, preserve completion and manual changes during classification.
  A replay can test completed examples on copies without reopening them.

## Decisions at each boundary

1. **Capture:** save the original message and attachments. Capturing a message does
   not itself create an item.
2. **Extract:** propose zero or more distinct items with exact source links. Keep a
   status reminder and a question separate when they need different outcomes.
3. **Classify:** choose an item kind from the source evidence. If
   the kind or intended recipient is unclear, leave it visible for owner review;
   uncertainty is not a fourth item kind and is not grounds for deletion.
4. **Reconcile:** update an existing item when it is the same underlying outcome;
   otherwise retain a separate item. Preserve owner-approved merges and corrections.
5. **Resolve:** review later evidence against the kind-specific outcome. A reply
   that answers a question can resolve that question; a task needs evidence that
   its work is complete; a reminder remains until handled or dismissed.
6. **Correct:** the owner can change kind, completion, notes, or grouping. Store
   the correction as authoritative while retaining the source and history.

The decision connection assesses classifications and completion evidence. It does
not perform these transitions by itself: application rules validate the evidence,
protect manual decisions, and apply reversible changes. Do not rely on an arbitrary
confidence threshold as a substitute for checking real examples and mistakes.

## Acceptance examples

| Evidence                                                                              | Expected outcome                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A shared project status reports a blocker without requesting new work.                | Consider a reminder rather than a new multi-step task.                                                 |
| A status report asks the owner for a decision.                                        | A question for the owner; do not infer the answer.                                                     |
| An operational screenshot reports a service issue that needs attention.               | Task, even without an explicit caption.                                                                |
| Someone asks the owner a question, then the owner clearly answers that same question. | Question becomes answered; unrelated work stays open.                                                  |
| The owner asks someone else a question.                                               | Do not create a question for the owner to answer. Track a clearly outstanding response in Waiting For. |
| A screenshot quotes “waiting on you,” but its intended recipient is unknown.          | Keep the ambiguity visible; do not assume the quoted person is the owner.                              |
| A reminder mentions a time.                                                           | Show the time in the app when supported; do not send a notification.                                   |
| The owner changes a kind or reopens a completed item.                                 | Preserve that correction through later model runs.                                                     |

## Boundaries and compatibility

The workspace, Chrome companion, MCP, exports, and links all consume the same
item identity and source evidence. Any implementation must keep existing TODO
references and completion history stable, expose kinds consistently across these
surfaces, and avoid treating completion-confirmation prompts as conversation
questions. Older records without a known kind need a visible migration/default and
an owner-correctable path; migration must not reinterpret a manual completion.

The decision provider receives only the linked evidence required for its review.
The task-generation model's existing conversation context is separate and may be
broader. A manual owner correction wins over a later automatic classification.

The item kinds are stored as `Task` records with one completion flag. Its
`Question` records are _completion-confirmation prompts_, not questions from a
conversation. Waiting items are stored separately, with their own state.
