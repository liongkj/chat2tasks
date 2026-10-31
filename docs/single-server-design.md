# One server per shared workspace

This document describes the intended desktop sharing and server-move behavior. The existing workspace export is an encrypted **copy**; it is not a server move. The handover described below is not available until the complete flow and recovery checks are implemented.

## Problem

A shared workspace has one active processor and can be viewed from several installed desktop apps. Any supported machine may be chosen as its server. The desktop service uses a per-launch token locally and can be shared through authenticated private HTTPS. A new installation must choose whether to start its own workspace or connect to one that already exists. A local process lock prevents a second copy of the same desktop workspace starting on that computer; it does not coordinate copies on different machines.

When the owner moves a workspace, the old server must stop accepting changes and be durably fenced before the target can process the same workspace. An uncertain activation must not restart the old processor. This is the planned-move model used by [BB](https://github.com/get-bb/bb/blob/916d684ac23d0b0de82c09cfc7553a50287d2188/packages/templates/src/templates/bb-guide-machines.md#L230-L299). It does not prevent unrelated independent workspaces or offer automatic failover.

## Usage

1. The owner starts a workspace on one computer and enables authenticated sharing through a private HTTPS address. Other computers install the app and connect to that workspace without starting a local processor.
2. An enrolled client can request **Move this workspace here**. The current server verifies the destination, stops and drains work, prepares the data, and fences itself before permitting the destination to activate. The old computer then becomes a client.
3. If either computer cannot confirm the outcome, the UI shows recovery. Retrying the same operation continues it; an uncertain old owner never resumes automatically. Clients that were offline may need the new server address when the old address is unavailable.

The existing encrypted export/import remains a non-destructive copy: the original keeps running and imported conversations stay paused. It does not transfer authority.

## Shape

Each workspace has a stable identity and one enrolled owner. Each installation has its own machine identity. A persisted, validated ownership journal outside the copied database is read before a local server or gateway starts. An existing workspace is upgraded without replacing its data. An invalid or incomplete journal fails closed.

The source transitions through `active → preparing → fenced → retired`. The target transitions through `client → staging → prepared → activating → active`. A move ID identifies retries. Before activation the source durably records the fence and issues a grant binding the workspace, next ownership generation, target identity, target address, and staged archive digest. The source signing key must not be included in the pre-fence snapshot; the target uses a new signing identity authorized by that grant. The target can activate only that staged archive with that grant. The source cannot automatically return to active after the grant may have escaped. Journal writes and target promotion must survive process or machine restart.

The server owns request admission and quiescence. Preparing a move rejects new mutations and returns a retryable error for webhooks, then waits for accepted requests and background writers to stop. This includes message analysis, thread organization, remote events, startup work, and detached search indexing. A timer stop alone is insufficient. Only then can the final SQLite snapshot and media be created. A process-lifetime local ownership lock is also needed before starting the workspace or its gateway.

Desktop sharing uses a stable loopback service behind private HTTPS. Local Tauri requests retain their per-launch token; remote clients authenticate separately with the workspace's owner credentials. A remote page never receives native filesystem or process commands. Machine enrollment and move authorization are limited to the workspace owner, with short-lived pairing and per-machine credentials.

The move archive is distinct from the existing copy format and preserves pending work. Gateway and Codex session data are stored outside the workspace; until their cross-platform portability is verified, the target must keep those connections paused and ask the owner to reconnect. The old files remain as a fenced recovery copy. Retarget webhooks and reconcile history after the new owner is active; an interruption can still miss events outside the gateway's retry and history coverage.

## Design decision

The paired online handover is the base because it supports a move from another enrolled computer, as BB does. The alternative was a destination-bound encrypted file handed over manually. It has a smaller transport surface but requires access to both machines and manual client address changes. Its useful parts remain: stage and validate data before activation, retain the old copy, and keep ambiguous states fenced.

A shared cloud lease would be needed for stronger guarantees such as autonomous failover across a network partition. It is not required for a planned move. Network discovery or a shared SQLite file alone cannot fence an isolated old owner. An owner-forced recovery or a separately created workspace remains outside this planned-move guarantee.

## Verification

Use synthetic conversations and local fake services. Check first-run role selection and the real installed client journey on each supported platform. For ownership, test that an uncommitted target cannot start, the old owner stays fenced after restart or a lost activation response, repeated messages are idempotent, and corrupt or wrongly addressed transfers leave the target unchanged. Exercise in-flight analysis, webhooks, search indexing, and client reconnects around the snapshot boundary. Verify the ordinary copy operation still leaves its source active and the imported chats paused.

## Next step

The durable ownership record, target-bound grant, and old-server restart guard are groundwork only. They are not connected to a move control. Add quiescence, transfer, destination promotion, and recovery before exposing the move operation, and verify the affected desktop journeys together.
