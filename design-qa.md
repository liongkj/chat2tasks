# Task workspace design QA

final result: passed

## Evidence and state

- Source visual truth: `docs/qa/apple-target.png`, the selected Apple direction, 1487 × 1058 pixels. It presents a desktop workspace and a companion panel together.
- Rendered implementation: `docs/workspace.png` (1080 × 1058) and `docs/companion.png` (390 × 1058). Both are actual Chromium captures of the compiled app with fictional sample data, with the onboarding task selected and its source visible.
- CSS viewports match those implementation pixel sizes, at device scale factor 1. Source desktop region is approximately 1078 × 1058; source companion region is 391 × 1058. Neither reference nor implementation was stretched. The comparison pads the desktop difference and uses a neutral gutter.
- Full-view comparison: `docs/qa/apple-final.png`. Focused comparison of the companion's typography, quote, completion action and persistent footer: `docs/qa/apple-panel.png`. These combine source and implementation in the same image. Initial comparison: `docs/qa/apple-initial.png`.
- Additional tested view: 390 × 844 CSS pixels for mobile list, navigation and task details. The desktop preview was also opened and operated in Codex's in-app browser at its available narrow width.

## Findings and comparison history

1. The initial comparison showed a desktop list narrower than the selected design, causing avoidable title wrapping. Severity P2. The compact desktop now uses a 232px sidebar and 46% list track. The final comparison shows the list/detail divider close to the reference, with readable titles.
2. The companion initially repeated the task description and exposed filters and multiple detail disclosures ahead of the next task. Severity P2. The title now precedes navigation; filters are disclosed by a named button; notes and secondary details share one disclosure. The final comparison shows the source and primary completion action together, with the next task visible below.
3. A capture taken immediately after resizing Chromium had stale pixels in its footer. This was a capture artifact: DOM assertions showed the connection status. The final fixture starts at the intended viewport and the recaptured footer visibly matches its DOM status.

No actionable P0/P1/P2 findings remain.

## Required fidelity surfaces

- Fonts and typography: system sans, strong heading hierarchy, 16–17px task titles, 14px minimum secondary task text. Real browser checks enforce minimum type sizes and at least 4.5:1 contrast for task titles and conversation labels in both surfaces. Headings wrap naturally, without truncating task content.
- Spacing and layout: pearl sidebar, white list/detail surfaces, restrained blue selection, thin separators and one dominant completion action. Main content scrolls independently; completion stays visible on the desktop/mobile detail view; companion connection controls remain outside the scrolling list.
- Colors and tokens: shared `src/shared/theme.css` owns foreground, secondary text, blue action/selection, borders and semantic colors. Text is dark enough to read on both white and selected surfaces.
- Image quality and assets: this target has no illustrations or photographic content. Existing Lucide icons supply standard controls. The app wordmark is live text. Existing extension toolbar icons remain unchanged; no reference logo was approximated with CSS art. Cached conversation images remain available in the full source view.
- Copy and content: the app displays actual task titles, notes and source text from the sample data. Its task model has readiness states and whole-task completion, not due dates or independently completed substeps. Accordingly it retains Up next / Needs a detail / Waiting and uses an ordered step list. Invented due dates and nonfunctional subtask checkboxes from the generated mock are not introduced. Longer actual quotes require more height than the short generated example.

The displayed conversation label follows `Task.source_ids → Message.id → Message.chatId/sessionId → settings.chats.name`. The quote uses `Message.body`; task completion uses `Task.done`. A companion conversation link opens the exact task and source view.

## Interaction checks

- Desktop task selection, source view, note persistence, completion/reopen, completed navigation and model-connection dialog.
- Mobile navigation, list/detail switching, visible completion control and no horizontal overflow.
- Built extension pairing, inline expansion, notes, completion/completed view, conversation activation, reviewed capture, exact source deep link and immediate access loss after revocation.
- The browser captured no application errors in the workspace E2E. The in-app preview was inspected visually. Native Chrome optional-host approval remains a manual installation step; the existing isolated E2E pre-approves only its local fixture server.
- Validation: production build, 25 backend tests, and both critical browser flows passed.

## Follow-up polish

- P3: system font metrics vary slightly between operating systems. Keep the native system font rather than distributing Apple's proprietary fonts.
- P3: real source text and existing readiness groups make some rows taller than the generated example. They scroll normally and retain the original information.

## Implementation checklist

- [x] Compare full and focused views against the selected design.
- [x] Fix material hierarchy and spacing differences, then recapture.
- [x] Verify affected critical flows and the readability regression.
- [x] Keep original task/source data and backend processing behavior.
