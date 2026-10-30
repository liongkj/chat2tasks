# Chat2Tasks domain: a GTD-inspired design

**Status: design proposal, not a description of fully implemented behavior.** The
current draft implementation has Tasks, Questions, and Reminders. The additional
concepts below are proposed so the domain can handle more kinds of conversation
without turning everything into a task.

## Purpose

Chat2Tasks helps one workspace owner notice, decide, and follow through on things
found in conversations. A message is evidence: it can contain no item, one item,
or several distinct items. An item can also have evidence from several messages.

The design follows the GTD stages of capture, clarify, organize, reflect, and
engage. GTD distinguishes an intended outcome from its next physical action; it
also uses Waiting For, Someday/Maybe, reference, and calendar information. See the
[GTD workflow](https://gettingthingsdone.com/wp-content/uploads/2024/05/GTD_workflow_map.pdf)
and [key definitions](https://gettingthingsdone.com/2010/10/some-key-gtd-definitions/).
The product adapts those ideas to the owner's language and preferences; its
categories need not reproduce the book's list names.

The owner has already chosen separate Tasks, Questions, and Reminders sections.
Questions are only for things the owner needs to answer. Reminders are in-app only,
including when a source mentions a time. The app does not send messages or perform
the work.

## The things the owner can track

These are the proposed meanings. A label is chosen for the underlying outcome,
not merely for a word, punctuation mark, message length, or predicted duration.

| Concept       | Meaning                                                                                                                         | Example                                                           | When it leaves the active view                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Task          | Substantial work or an operational issue that needs an outcome, often with multiple steps.                                      | Investigate and resolve a service alert.                          | The outcome is complete, or the owner cancels it.                                         |
| Action        | One concrete piece of work the owner can do. It can stand alone or be the next step of a task.                                  | Send an already-prepared PDF.                                     | The action is done or cancelled.                                                          |
| Question      | A specific answer or decision the owner needs to provide.                                                                       | Decide which version to approve.                                  | The specific question has been substantively answered or dismissed by the owner.          |
| Reminder      | Information the owner wants to see again that does not itself describe a separate assignment.                                   | A project update says a dependency is blocked.                    | The owner dismisses or handles it.                                                        |
| Waiting for   | An expected response, delivery, or outcome from someone or something else. It can stand alone or be linked to a task or action. | The owner asked a colleague for a document and is waiting for it. | The expected result arrives, or the owner stops tracking it.                              |
| Someday/Maybe | An idea or possible outcome the owner has chosen to retain without committing to it now.                                        | Consider a future integration.                                    | The owner activates or removes it.                                                        |
| Event         | An occurrence relevant to the owner at a particular date or time, rather than work to perform by itself.                        | A meeting the owner is invited to attend.                         | Its time passes, it is cancelled, or the owner removes it. Past events remain in history. |
| Reference     | Information worth finding later, without an immediate reason to act or be reminded.                                             | A link to a specification.                                        | It remains searchable until the owner removes it.                                         |

An ordinary greeting, acknowledgement, irrelevant status message, or unselected
idea need not produce any tracked item. The original conversation stays available.
The system should not fill a Reference collection with everything it reads.

**Proposed navigation:** retain Tasks, Questions, and Reminders as separate
sections; add an Actions section for standalone actions and a Waiting For view.
Add Someday/Maybe and an in-app Upcoming view when those needs are established;
reference can begin as saved source material rather than a prominent section. A
Review view can hold meaningful items whose kind or ownership is uncertain without
claiming they are confirmed work for the owner.
The exact placement of short actions and whether Waiting For is automatic are
owner choices, not assumptions in this proposal.

## Kinds, states, and views are different

The app should not make every useful label a competing item type.

- **Kind** describes the main outcome: task, action, question, or reminder.
- **Lifecycle** records whether that outcome is open, resolved, dismissed, or
  cancelled. The words shown to the owner depend on kind: a question is answered,
  an action or task is completed, and a reminder is dismissed.
- **Readiness** describes why open work can or cannot move now: ready, needs
  clarification, waiting for someone, or deferred. Waiting does not mean done.
- **Commitment** distinguishes active work from a possible Someday/Maybe item.
  An uncommitted idea is not an overdue task. A committed task deferred until a
  known date remains a commitment; it is not automatically Someday/Maybe.
- **Time** is a property or view, not a kind. An action, question, reminder, or
  event can be relevant on a date. A due time, scheduled time, and optional time to
  revisit are different facts.
- **Project** groups related outcomes when useful. A substantial task may itself
  be a GTD project; the app should not automatically create a duplicate project for
  every task. A work project or business area is also not automatically the same
  as a GTD project outcome.
- **Area of responsibility** is an ongoing sphere such as a business or personal
  responsibility. It can group work over time and is not itself a finishable task.
- **Recurrence** describes work the owner intends to repeat. It is a property of
  an action or task, not a separate category. Completing one occurrence does not
  prove future occurrences are complete.
- **Context, priority, person, and conversation** can help the owner filter work;
  they are not evidence of a new obligation.
- **Views** such as Waiting For, Upcoming, and All items can show the same item in
  different contexts without making copies or counting one item twice in totals.

For example, an open task can be waiting for an answer, have a due date, and belong
to a project. Those facts do not make it four tasks. A question can have a next
action such as “choose an option”; that step does not automatically become a
second independent item.

An **Inbox** or **Review** queue is a place to clarify meaningful uncertain
evidence. It is not another category of task, and it need not show every incoming
WhatsApp message. A confirmed item may appear in another view when useful, but the
views continue to point to the same record.

## Waiting for someone

A wait needs a description of the expected result, the person or system expected
to provide it when known, linked evidence, and an optional owner-set follow-up
date. It may link to an existing item or stand on its own. The source should make
it clear why the owner is tracking it; an outgoing message alone does not establish
that every recipient owes a response.

When the expected response is clearly received, the wait may be marked received
with its evidence. That does **not** automatically complete the related task: it
may instead make the task ready for its next action. An unrelated reply, a promise,
or the passage of a follow-up date is not proof that the wait ended. Ambiguity
stays reviewable. No follow-up is sent automatically.

Questions the owner asks other people do not appear under Questions for the owner
to answer. If tracking that reply is desired, they can appear under Waiting For.
Whether such waits are suggested automatically or only created by the owner is an
open product choice.

## Time and reminders

Keep the source's stated time and its meaning: **at** a time, **by** a deadline,
**on** a date, or **revisit after** a date. Preserve date-only values and uncertainty
instead of inventing an hour, year, timezone, or deadline. A relative date requires
the source timestamp and any needed timezone to be known; otherwise retain the
original wording for review.

Upcoming is an in-app view over relevant dates and events. Showing an item there
does not create an event in an external calendar, send a notification, or mark the
item done when the date passes. A dated reminder attached to an existing item should
normally be a time on that item, not a duplicate task. A standalone heads-up can
remain a reminder in its own right.

GTD's two-minute guideline is advice to the person deciding what to do. Chat2Tasks
must not assume a short item is complete or perform it automatically.

For explicitly recurring work, retain the stated or owner-set cadence and the
individual occurrence's status. Do not invent a cadence from repeated messages,
silently complete later occurrences, or send notifications. A later implementation
can show the next occurrence without filling the list with all future repetitions.

## Clarify and reconcile conversation evidence

1. **Capture:** keep the original message, its direction and timestamp, relevant
   reply links, and available attachment evidence. Capture alone does not create
   an obligation.
2. **Identify outcomes:** find distinct requests, questions, relevant reminders,
   waits, events, or possible future ideas. A single source may support several
   outcomes; repeated messages about one outcome should not multiply it.
3. **Establish ownership:** distinguish an incoming request to the owner, a
   request the owner made of someone else, an item assigned to a third person, and
   an unknown recipient. Group-chat context and text inside a screenshot do not by
   themselves establish that “you” means the workspace owner.
4. **Classify and organize:** propose a kind and any supported relationship,
   readiness, commitment, or time. Keep uncertain cases visible for review rather
   than inventing an assignment or silently discarding the evidence.
5. **Reconcile:** compare later messages with the existing outcome. Add evidence or
   propose a state change when the match is clear; otherwise ask for review.
6. **Reflect and engage:** the owner reviews open work, waiting items, and later
   ideas in the app, chooses what to do, and can correct any classification.

The configured Decisions API can assess narrow questions such as “is this for the
owner?”, “does this reply answer this specific question?”, or “is this a wait for
someone else?”. It should receive the linked evidence needed for that assessment.
The application remains responsible for applying domain rules and preserving
corrections. A model score is not proof of correctness or a calibrated probability;
thresholds require evaluation against owner-labeled examples.

## Resolution and owner control

- An exact, substantive outgoing answer can resolve the matching owner-directed
  question. A partial answer leaves the unanswered part open; separate work remains
  open. An acknowledgement, promise, or unrelated answer is insufficient.
- If the answer was already present before extraction, do not create a new open
  question. Retain the conversation and, when useful, a resolved record with its
  evidence rather than silently erasing history.
- A task needs evidence that its whole outcome was achieved, not just that one
  question or step was answered. A single action needs evidence for that action.
- A reminder remains active until the owner handles or dismisses it. An automatic
  completion rule for a task must not silently dismiss a reminder.
- A received result resolves a wait, not necessarily the linked task. A date passing
  changes an event's placement in Upcoming but does not prove a task was completed.
- The owner can correct kind, time, relationship, grouping, or state. A correction,
  manual completion, or reopening remains authoritative on later analysis. Keep
  the item reference, evidence, notes, and history; do not silently delete or reopen
  an item during reclassification.
- If the app cannot establish the recipient, outcome, or relationship, it should
  show that uncertainty. It must not present an unverified question as definitely
  addressed to the owner or auto-resolve an uncertain item.

## Examples and acceptance rules

| Evidence                                                                                   | Expected treatment                                                                                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| “Can you send me the PDF?” directed to the owner.                                          | One standalone Action, if that section is adopted.                                                                 |
| “Which option should we choose?” directed to the owner, followed by their specific answer. | One Question; mark answered only when the answer matches it.                                                       |
| The owner asks someone else for a PDF.                                                     | Not a Question for the owner. Propose or create a Waiting For record according to the owner's tracking preference. |
| A colleague sends the requested PDF while an investigation remains unfinished.             | Mark the matching wait received; leave the investigation open and reassess its next action.                        |
| A screenshot reports an operational problem that needs investigation.                      | A Task, even without a caption.                                                                                    |
| A screenshot contains a status update and a separate question.                             | Potentially a Reminder and a Question; confirm the question's recipient instead of assuming it.                    |
| A message says “meeting Tuesday at 10” and the owner's involvement is clear.               | An Event in the in-app Upcoming view; preserve any timezone uncertainty and do not send a notification.            |
| “Maybe we could add an integration next year.”                                             | A possible Someday/Maybe idea only if the owner wants to retain it; not committed work.                            |
| A useful link with no request or reminder.                                                 | Searchable source or owner-saved Reference; not an open task.                                                      |
| “Please read the specification before the meeting.”                                        | An Action to read it, linked to the specification; the specification itself is Reference.                          |
| A reminder says “check again Friday.”                                                      | Display the stated timing in the app when supported; do not create a notification.                                 |
| The owner explicitly asks for a weekly review.                                             | An in-app recurring action; completing this week's occurrence does not complete next week's.                       |
| A question is answered, but the message also requested a separate implementation.          | Resolve only the question; the implementation remains open.                                                        |
| The owner corrects a category or reopens an item.                                          | Keep the correction and completion history through later analysis.                                                 |

## How this relates to the current draft

The existing draft stores Tasks, Questions, and Reminders as task records with a
kind, a completion flag, readiness fields, source links, and a possible category
review. Its separate completion-confirmation questions are not conversation
questions. It does not yet provide the full Action, Waiting For, Someday/Maybe,
Event, Reference, or Project behavior described above.
The Review and Upcoming views, recurrence, and area-of-responsibility grouping are
also design proposals, not implemented features.

Any future implementation needs a migration that keeps existing TODO references,
source links, completion records, personal notes, and owner corrections intact.
Existing items should not be split, reopened, or moved merely because a new kind is
introduced. Reclassification should be reviewable and reversible. Test the new
rules first against a larger set of owner-labeled examples, including messages
already answered, ambiguous recipients, waits, screenshots, and multi-outcome
messages. Record the expected owner, kind, status, and supporting evidence before
running the model. Compare incorrect additions and missed obligations by category,
alongside how often the owner has to review a case. A handful of examples cannot
establish accuracy or calibrate a confidence threshold.
