# Task desk design QA

final result: passed

## Selected target and captured state

The owner selected **Task desk**, the first of three working primary-workspace alternatives. Its reference is the rendered prototype, rather than the earlier conversation-led image concept.

- Desktop target: `work/design-qa/task-desk/reference-desktop.jpg`, 1440 × 1000.
- Phone targets: `reference-mobile.jpg` and `reference-detail-mobile.jpg` in the same local QA folder, both 390 × 844.
- Implementation: `docs/qa/task-desk/desktop.jpg`, `mobile.jpg` and `mobile-detail.jpg`, at the same respective CSS viewport sizes and device scale factor 1.
- Combined desktop comparison: `work/design-qa/task-desk/comparison-desktop.jpg`, generated from `desktop.html`. It places both full views together, followed by readable task-document crops at native scale. The document begins at x=560 in both desktop captures.
- Combined phone comparison: `work/design-qa/task-desk/comparison-mobile.jpg`, generated from `mobile.html`. The queue and document states are each shown beside their reference at native 390px width.
- State: all open work across conversations; TODO-001 is selected in the desktop document and opened from the phone queue. Original messages and Notes & handoff are collapsed.
- Captures use an independent synthetic database. Its five cases, wording, priorities and update times differ from the six-case prototype. Queue ordering and displayed counts come from those records. No production messages are in the published captures.

## Delivered behaviour

Task desk is the default route. The sidebar selects readiness and conversation filters, the queue sorts open work by priority and update time, and the task document contains the blocker, next steps and completion criteria. Original messages expand inline. Notes, link copying, handoff downloads, merging and merge history remain under Notes & handoff.

On phones, the queue comes first. A task opens in a full-screen Base UI dialog; returning restores the source control's focus. Completion and Undo use the existing persisted tick request, pending-write guard, optimistic update, rollback and refresh gate. Undo remains available inside the task dialog. Returning after completion and undo can find the recreated queue row by its stable task reference.

Conversations, Activity and Settings remain reachable from the sidebar. The task menu retains manual analysis, export, import and the combined open/completed view. Existing task aliases, merged-task links, conversation links, search and browser history continue to work. Readiness filters are validated against the task schema and persisted as `state=…` in the URL.

## Fidelity review

- **Geometry:** at 1440 × 1000, measured navigation, queue and document widths are exactly 210px, 350px and 880px, matching the selected prototype. The four-region conversation-first default is replaced by these three regions. On phones the queue and document each occupy the available width.
- **Typography:** system sans throughout. Desktop task headings are 29px, phone headings 27px, queue titles 16px and secondary task text 14px. The readable-workspace check verifies at least 4.5:1 contrast for primary queue text. Full source text and long tokens remain readable and wrap within their scroll surface.
- **Colour:** white surfaces, neutral greys and graphite actions; amber identifies missing information and green indicates confirmed completion or connection status. The selected palette is retained across settings and dialogs. The extension keeps its existing visual design.
- **Spacing and hierarchy:** the task reference and readiness precede the title; background and blocker precede next steps and criteria. The completion control stays in the document footer. Source and note disclosures use simple dividers. Sidebar and queue scroll independently.
- **Assets:** standard Lucide icons. Cached source images, reply quotes, browser provenance and image-reading uncertainty remain available. No decorative raster assets were required.
- **Intentional product details:** More task actions and the search shortcut retain existing capabilities. Notes & handoff names the full existing disclosure rather than the prototype's shorter Add a note label. The sidebar retains destinations for conversation browsing, activity and settings. A fresh phone queue has no selected-task highlight until a task is opened; a direct TODO link opens its document.

No actionable P0/P1/P2 visual findings remain in the reviewed primary flow. Different sample text changes wrapping and vertical positions without changing the layout geometry.

## Exact field mappings

| Display | Source |
| --- | --- |
| Task reference | `Task.reference`; legacy ID and merged references resolve through existing matching rules |
| Readiness | `Task.triage_state`; Reported done remains separate from manual completion |
| Completed state | `Task.done`; Undo writes the previous boolean through `/api/tick` |
| Missing-information question | `Task.blocking_question` |
| Background, next steps, complete when | `Task.note`, `Task.action_steps`, `Task.done_when` |
| Personal note | `Task.own_remark`; saving it does not change readiness |
| Original-message count | `Task.source_ids.length` |
| Rendered original messages | `Task.source_ids` matched to `Message.id`; a missing cached source is not fabricated |
| Conversation label/filter | Source `Message.sessionId/chatId` matched to `Chat.sessionId/chatId`; `Chat.name` is the label |
| Multiple-conversation label | Number of distinct session/chat pairs among the task's source messages |
| Original text, direction, time | `Message.body`, `Message.direction`, `Message.timestamp`; incoming labels name the conversation, not an inferred sender |
| Queue and filter counts | The same task-query function applies conversation scope, search, readiness and completion filters |
| Queue ordering | Open tasks before completed tasks in the combined view, then `Task.priority === 'high'`, then descending `Task.updated` |
| Activity receipt and analysis times | `Snapshot.status.last_webhook` and `Snapshot.status.last_extract`, respectively |
| Workspace server availability | A successful `/api/state` response; it does not assert that a message or analysis just occurred |

## Verification and limits

- Production build passed, including TypeScript, web assets, the packaged extension and bundled server. Subsequent presentation and URL-validation edits passed TypeScript/web checks.
- All eight existing browser journeys are covered by passing local results. The final targeted rerun passed the desktop/phone completion and undo journey and packaged-extension journey after correcting return focus and keeping the extension's original button label in its test. The six other journeys passed and their unchanged evidence was reused.
- Browser coverage includes TODO links and history, persisted readiness selection, copy links, notes, completion latency and rollback, desktop/phone Undo, focus after a queue row is recreated, 320px long names and note controls, model dialogs, extension pairing/capture/revocation, conversation discovery, manual merging and old-reference redirects, cross-conversation evidence, delayed settings, and settings-load recovery.
- The compiled implementation was inspected in the in-app browser at 1440 × 1000 and 390 × 844, and compared against the chosen prototype in the same combined inputs. Tablet conversation layout also accommodates the wider application sidebar.
- Backend source, contracts, dependencies and deployment configuration are unchanged. Production task writes, model calls and deployment were not used for QA. The local preview remains on a separate sample database.
- Existing dependency-annotation and bundle-size build warnings remain informational; their thresholds were not changed.

## Implementation checklist

- [x] Promote the selected task-first information architecture into the application.
- [x] Use real task, source, conversation and completion contracts.
- [x] Keep queue, counts and desktop selection on the same filtering logic.
- [x] Preserve notes, handoff, merging, aliases, source attachments and secondary destinations.
- [x] Persist readiness, conversation, search and evidence navigation in links.
- [x] Verify completion/undo persistence, rollback and mobile focus return.
- [x] Compare desktop, phone queue and phone document against the selected prototype.
