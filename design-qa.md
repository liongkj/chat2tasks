# GTD workspace design QA

final result: passed

## Evidence and state

- Generated reference: `docs/qa/gtd-desk/concept.png`, 1487 × 1058 pixels.
- Implemented Actions view: `docs/qa/gtd-desk/actions.png`, captured at a
  1487 × 1058 CSS viewport, device scale factor 1, with the source message open.
- Full-view and focused comparison: `docs/qa/gtd-desk/comparison.png`. The
  comparison places both 1487 × 1058 source images side by side at the same
  scale, followed by native-size crops of the detail pane. The comparison page
  is 1280 × 945 pixels.
- Additional implementation captures: `docs/qa/gtd-desk/overview.png` at
  1487 × 1058 and `docs/qa/gtd-desk/waiting-mobile.png` at 390 × 844. Both
  use device scale factor 1.
- All implementation captures use a separate fictional demo database. The
  generated concept contains five fictional actions; the implemented demo has
  one. The concept depicts multi-step work, whereas the selected demo action is
  one step and does not invent a checklist or attachments.

## Findings and iteration

- **Resolved P2, desktop proportions:** the first implementation retained the
  old 350px queue at the reference width, starting the detail pane almost 100px
  earlier than the concept. The queue now grows to 440px on wide screens and
  the detail inset was adjusted. In the final capture the detail pane begins at
  x=650, compared with approximately x=659 in the concept.
- **Resolved P2, typography:** the original 12px navigation and 21px list heading
  were noticeably smaller than the concept. Navigation is now 14px, the list
  heading 24px, and the detail title 32px. The existing system sans font and
  readable body copy remain consistent across views.
- **Resolved P2, dashboard state:** after returning from Actions, the status
  count reflected the previous category instead of all open items. The count
  now reflects the dashboard's full context; the browser journey verifies it.
- **Resolved P2, linked Someday work:** opening a parked linked item from
  Waiting for now opens the Someday / Maybe view. The browser journey verifies
  the destination and keeps the item linked.
- No remaining actionable P0/P1/P2 findings were identified in the reviewed
  flows. Minor differences include the number of demo rows, semantic icons,
  and labels, and can be refined in a later design iteration.

## Fidelity and behavior

The three-column desktop structure, selected row, monochrome palette, source
panel, dividers, and persistent completion action follow the generated concept.
Overview is a separate dashboard because the owner chose Tasks as a list.
The implementation displays real evidence and does not manufacture priority,
ownership, steps, or files to match the concept. Standard Lucide icons are used;
the concept has no required decorative imagery. Text and controls remain
readable and within the phone viewport. The phone waiting detail shows its
linked item, source, and state actions.

The built-in browser was used to inspect Overview, Actions with source evidence,
and Waiting for at desktop and phone sizes. The console contained no errors.
The full test suite passed 73 tests; the existing browser suite passed nine
unchanged journeys, and its two affected workspace/companion journeys passed on
targeted reruns after the selector and layout changes. The final workspace
rerun additionally verifies counts and Someday navigation. TypeScript and the
production build passed. No production workspace data was used for visual QA.

## Checklist

- [x] Implement the generated work-desk layout with real, source-linked data.
- [x] Keep Overview separate from Tasks, Actions, Questions, Reminders and Waiting for.
- [x] Verify desktop and phone navigation, state changes, and linked work.
- [x] Compare the reference and implementation together, then fix the identified differences.

# Previous Task desk design QA (historical)

Historical result: passed

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
