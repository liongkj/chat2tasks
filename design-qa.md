# Context First design QA

final result: passed

## Visual target and captured state

- Selected visual target: the second displayed ideation result, **Context First**, chosen by the owner. The original generated board is 1586 × 992 pixels.
- Local visual truth: `work/design-qa/reference.png`. The original board and comparison captures remain in ignored local QA storage. Published implementation captures use illustrative sample data.
- Desktop implementation: `docs/qa/context-first/desktop.jpg`, 1440 × 1000 pixels, 1440 × 1000 CSS viewport, device scale factor 1.
- Mobile implementation: `docs/qa/context-first/mobile.jpg`, 390 × 844 pixels, 390 × 844 CSS viewport, device scale factor 1.
- State: Operations selected, an incomplete task needing information selected, three linked messages highlighted, original messages visible. Sample references and conversation names differ from the generated board; no production messages were used in the implementation captures.
- Source desktop normalization: crop the app region at approximately x=22, y=108, width=1227, height=853; scale uniformly to 1440px wide and crop the small bottom remainder to the 1000px viewport. Presentation title and mobile panel are excluded.
- Source mobile normalization: crop the mobile content at approximately x=1266, y=110, width=300; scale uniformly by 1.3 to 390px wide and inspect its first 844px. The generated board's taller mobile continuation is cropped, not stretched.
- Combined full-view comparison: `work/design-qa/comparison-final.jpg`; its source and implementation are in the same comparison input. The reproducible local layout is `work/design-qa/comparison-final.html`.
- Focused comparisons: `work/design-qa/comparison-mobile-final.jpg` and `work/design-qa/comparison-detail-final.jpg`. These make the mobile action, serif title, blocker and criteria readable at useful scale. The task pane is normalized to 450px in both focused views.
- Palette refinement: the owner subsequently rejected the sage-and-ivory scheme. The published desktop and mobile captures now show the revised white, grey and graphite palette. The local reference comparisons above document the earlier layout and typography review; their palette is superseded by this feedback.

## Findings and comparison history

1. **P2 — desktop proportions and typography.** The first implementation used a 250px conversation list and 400px task pane at 1440px; its thread occupied too much width. The title and body text were also smaller than the reference. Evidence: `work/design-qa/desktop-initial.jpg` and `work/design-qa/comparison-initial.jpg`. The final layout uses 120px navigation, 336px conversation list, approximately 534px thread and 450px task pane at the captured desktop width. Serif titles, body sizes and semantic state text were adjusted. The final full-view and focused comparisons show the corrected proportions and wrapping.
2. **P2 — mobile task action below the first viewport.** Repeated message headings, extra status chrome and footer space delayed View task. Evidence: `work/design-qa/mobile-initial.jpg` and the initial comparison HTML. Consecutive messages from the same conversation and direction now share their source heading within a five-minute window; task annotations break that grouping. Mobile evidence filtering moved into the conversation menu, and redundant mobile footer space was removed. Final capture shows the source messages, blocker, next steps and View task together at 390 × 844.
3. **P2 — narrow unbreakable source names.** The existing 320px regression found detail overflow. The detail scroll surface now wraps long tokens, and the desktop header limits its source subtitle to two lines. The existing narrow-touch E2E passes.
4. **P1 — mobile focus and restoration.** The audit found focus reachable in hidden navigation. Closed desktop navigation is now removed from mobile layout; mobile navigation and task details use separate Base UI dialogs. Opening and returning from a task or conversation restores visible focus. The new critical-flow E2E verifies focus entry, containment, return and absence of off-screen focus.
5. **P1 — conversation link restored before settings arrive.** Conversation resolution now waits for its settings while task-only links can restore independently. The conversation E2E holds the real settings response until the task is rendered, then verifies that chat selection survives. It also verifies refresh and browser Back.
6. **P2 — decorative green and cream throughout the workspace.** The owner's colour feedback prompted a neutral palette across navigation, conversation selection, message bubbles, evidence markers, actions, dialogs and settings. White surfaces, grey selection and graphite actions now share web palette tokens. Amber identifies missing information; green is reserved for confirmed success and connection status. Layout and typography remain unchanged.

No actionable P0/P1/P2 visual or interaction findings remain in the reviewed flow.

## Required fidelity surfaces

- **Fonts and typography:** system sans for controls and messages; Times New Roman/system serif for app-owned editorial headings, matching the selected reference's character. The selected task title is 34px on desktop; message text is 16px; step and criterion text is 15px. Actual text is retained, with expandable background for long task notes. Existing readability checks still enforce task titles of at least 16px, secondary task text of at least 14px, and 4.5:1 contrast.
- **Spacing and layout:** a narrow workspace rail, followed conversations, saved-message thread and a linked-task pane. Desktop regions scroll independently. Mobile uses a single conversation page with inline task previews and a full-screen task dialog. Completion controls remain accessible in the task view; the mobile preview action is visible in the comparison viewport.
- **Colors and tokens:** white base, neutral grey surfaces and selection, graphite actions and charcoal text. Amber marks missing information; small green indicators mark confirmed success and connection status. Web tokens live in `src/client/style.css`; the extension's existing shared palette remains unchanged.
- **Image quality and assets:** the target contains no photographic or decorative raster assets. Standard Lucide icons match its line icon treatment; monograms represent the current user or saved conversation, not invented people. Real cached attachments, reply quotes, browser provenance and image-reading uncertainty remain available. No screenshot is used as the implementation.
- **Copy and content:** app-owned copy reflects real capabilities. Add missing information opens a personal note; it does not claim to clear the blocker. Completion criteria are plain criteria, rather than invented subtask completion state. Incoming labels identify the saved conversation because the message contract has no sender-name field. Merge tasks names the actual merge operation; Download handoff names its download result. All tasks, activity and connection setup remain available as functional destinations.

## Exact field mappings

- Conversation identity: `Chat.sessionId/chatId` matched against `Message.sessionId/chatId`; display label is `Chat.name`.
- Message text and timing: `Message.body`, `Message.direction`, `Message.timestamp`. Incoming text is labelled From plus the saved conversation name, not asserted to be an identified individual.
- Linked evidence: `Task.source_ids` matched against `Message.id`. A task merged across conversations opens the full task evidence view, so a conversation filter cannot hide some of its sources.
- Task state: `Task.triage_state`, `Task.blocking_question`, `Task.action_steps`, `Task.done_when`; manual completion is `Task.done`; personal note is `Task.own_remark`.
- Open count per conversation: unique incomplete tasks whose sources include a message in that conversation. A task with evidence in two conversations can appear in both contexts.
- Activity receipt timestamp: `Snapshot.status.last_webhook`; completed-analysis timestamp: `Snapshot.status.last_extract`. Server availability is the successful `/api/state` read, not evidence that a new message or task analysis has occurred.

## Verification and limits

- `npm test`: 36 backend/domain/integration tests passed. Backend source is unchanged.
- `npm run build`: TypeScript, web build, packaged extension and bundled server passed.
- `npm run test:extension`: eight critical browser journeys passed, covering completion latency and rollback, notes, task links, history, narrow wrapping, model dialogs, extension pairing/capture/revocation, conversation discovery, merging and old-reference redirects, cross-conversation evidence, delayed settings, mobile focus return, and recovery from a failed settings load.
- The local compiled implementation was opened and operated in the in-app browser. Desktop and mobile renders were inspected, and the reference and implementation were compared together.
- Palette follow-up: the web production build and existing readable-workspace browser journey passed again. Updated desktop and mobile captures were inspected alongside the settings page. Measured text contrast in the selected conversation and task surfaces ranges from 5.02:1 for message timestamps to 15.52:1 for task headings; primary actions measure 14.16:1. Earlier interaction evidence remains applicable to unchanged behaviour.
- Existing extension interactions passed; the extension's visual design was not reworked in this change.
- Production task mutations, model calls and deployment were not used as QA evidence. The preview uses an independent sample database.
- Build warnings about the existing dependency annotations and bundle-size threshold remain informational; no warning threshold was changed.

## Follow-up polish

- P3: mobile preview step numbers use the ordinary ordered-list treatment; the full task pane uses the reference's circular numbering.
- P3: system font metrics and locale-specific date ordering vary by platform. Source message length can change bubble height and scrolling.

## Implementation checklist

- [x] Resolve the selected concept and inspect its real image.
- [x] Compare full desktop and mobile views in the same input.
- [x] Compare readable task-detail and mobile regions.
- [x] Repair material proportions, typography and mobile action placement.
- [x] Preserve task persistence, evidence, manual completion and merge semantics.
- [x] Verify the critical flows and known mobile regressions.
