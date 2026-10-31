# One server per shared workspace

This document describes the desktop preview's sharing and planned server move. The existing workspace export is an encrypted **copy**; it is not a server move. Platform builds and real multi-computer testing are still required before release.

## Problem

A shared workspace has one active processor and can be viewed from several installed desktop apps. Any supported machine may be chosen as its server. The desktop service uses a per-launch token locally and can be shared through authenticated private HTTPS. A new installation must choose whether to start its own workspace or connect to one that already exists. A local process lock prevents a second copy of the same desktop workspace starting on that computer; it does not coordinate copies on different machines.

When the owner moves a workspace, the old server must stop accepting changes and be durably fenced before the target can process the same workspace. An uncertain activation must not restart the old processor. This is the planned-move model used by [BB](https://github.com/get-bb/bb/blob/916d684ac23d0b0de82c09cfc7553a50287d2188/packages/templates/src/templates/bb-guide-machines.md#L230-L299). It does not prevent unrelated independent workspaces or offer automatic failover.

## Usage

1. The owner starts a workspace on one computer and enables authenticated sharing through a private HTTPS address. Other computers install the app and connect to that workspace without starting a local processor.
2. On the destination computer, choose **Move an existing workspace here**, enter the old server's address and password, and configure the destination's private HTTPS address. The current server stops and drains work, prepares the data, and fences itself before the destination activates.
3. If a move is interrupted, reopen the app on the old server and retry on the destination with the same addresses and port. An uncertain old owner never resumes automatically. After confirmation, restart the old computer's app and update other clients to the new address.

The existing encrypted export/import remains a non-destructive copy: the original keeps running and imported conversations stay paused. It does not transfer authority.

## Shape

Each desktop workspace has a stable identity and an owner identity. The destination generates its own identity for a move. A persisted, validated ownership journal outside the copied database is read before a local server or gateway starts. An existing workspace is upgraded without replacing its data. An invalid or incomplete journal fails closed.

The source transitions through `active → preparing → fenced`; after the destination confirms activation, the source's selected workspace is changed to the destination address. The target transitions through `client → staged → active_moved`. A move ID identifies retries. Before activation the source durably records the fence and issues a grant binding the workspace, next ownership generation, target identity, target address, and snapshot digest. The source signing key is not included in the snapshot; the target uses its own signing identity authorized by the grant. The source cannot automatically return to active after the grant may have escaped.

The server owns request admission and quiescence. Preparing a move rejects new mutations and returns a retryable error for webhooks, then waits for accepted requests and background writers to stop. This includes message analysis, thread organization, remote events, startup work, and detached search indexing. A timer stop alone is insufficient. Only then can the final SQLite snapshot and media be created. A process-lifetime local ownership lock is also needed before starting the workspace or its gateway.

Desktop sharing uses a stable loopback service behind private HTTPS. Local Tauri requests retain their per-launch token; remote clients authenticate separately with the workspace's owner password. A remote page never receives native filesystem or process commands. The move uses that owner password and a destination-bound cryptographic grant; it does not provide per-machine sign-in or automatic discovery.

The move uses an encrypted workspace snapshot with a separate, target-bound grant and a dedicated import path that preserves pending work. Gateway and Codex session data are not transferred; the target keeps conversations paused until the owner reconnects them. Existing destination workspace and connection files are retained as backups. The old files remain as a fenced recovery copy. Reconcile history after the new owner is active; an interruption can still miss events outside the gateway's retry and history coverage.

## Design decision

The online handover is the base because it supports initiating a move from the destination computer, as BB does. The alternative was a destination-bound encrypted file handed over manually. Its useful parts remain: stage and validate data before activation, retain the old copy, and keep ambiguous states fenced.

A shared cloud lease would be needed for stronger guarantees such as autonomous failover across a network partition. It is not required for a planned move. Network discovery or a shared SQLite file alone cannot fence an isolated old owner. An owner-forced recovery or a separately created workspace remains outside this planned-move guarantee.

## Verification

Use synthetic conversations and local fake services. Check first-run role selection and the real installed client journey on each supported platform. For ownership, test that an uncommitted target cannot start, the old owner stays fenced after restart or a lost activation response, repeated messages are idempotent, and corrupt or wrongly addressed transfers leave the target unchanged. Exercise in-flight analysis, webhooks, search indexing, and client reconnects around the snapshot boundary. Verify the ordinary copy operation still leaves its source active and the imported chats paused.

## Release work

Verify the installed move journey on Windows, macOS, and Linux over a real private network, including reconnecting WhatsApp and Codex. The local offline tests use simulated services and two separate workspaces on one machine; they do not prove a real multi-computer deployment.
