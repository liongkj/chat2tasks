# Tauri and browser-free WhatsApp preview

The Tauri preview uses a separate application identifier and data directory. It does not open the
existing Electron workspace or reuse its WhatsApp session. An encrypted workspace transfer can be
selected explicitly; the previous preview workspace is kept as a backup.

On macOS, install the project dependencies and Rust, then run `npm run build`,
`npm run mac:prepare`, and `npm run tauri:build -- --bundles app`. The resulting preview is in
`src-tauri/target/release/bundle/macos/`. Windows packaging has not yet been implemented or tested.

For an isolated interface sample, start the preview with `--sample`. This uses fictional data and
does not start a WhatsApp gateway or synchronize messages.

## Desktop memory comparison

On one Mac, both windows displayed the same Overview and fictional tasks. Five interleaved macOS
physical-footprint samples gave a median of 132 MB for an Electron sample window and its helpers,
and 121 MB for the Tauri window and its WebKit helpers. Including the local sample service and the
Tauri supervisor, the medians were 187 MB for Electron and 205 MB for Tauri; the Tauri samples ranged
from 205 to 227 MB. The Electron comparison used a minimal shell around the same interface, not the
full shipping app. The Tauri supervisor was a separate Node process that used about 24 MB in one
sample. Neither sample included a WhatsApp gateway or a running Codex process.

These are point-in-time sample measurements on a busy Mac, not a prediction of either app's full
connected memory use. The Tauri Mac preview bundle is about 1.35 GiB because it still contains the
existing WhatsApp browser and runtime.

## Offline WhatsApp evidence

The browser-free OpenWA engine was tested in a temporary directory with non-local outbound network
connections blocked by macOS. The gateway reported `baileys` as its active engine and zero sessions.
OpenWA's existing offline inbound-message suite passed 13 cases, including text, images, edits and
reactions; it uses the real Baileys parser but does not download media or contact WhatsApp.

The unlinked gateway's macOS physical footprint was 267 MB in five samples. In a separate run,
the same gateway loaded the real Baileys library and parsed 1,000 fictional text messages before
starting; its footprint was 310 MB in five samples. The synthetic handler did not persist those
messages or download media. Both samples used the same pinned OpenWA version as the Mac app.

These are offline, unlinked measurements, not the memory consumption of a connected account. A
previous snapshot attributed approximately 1,360 MB to the current app's separate WhatsApp browser,
but that connected workload is not comparable to the synthetic test. The real saving remains
unknown until a separate test account and comparable message history can be measured.

OpenWA documents a higher account-restriction risk for its browser-free engine and requires sessions
to be linked again when changing engines. This preview does not change the engine or credentials of
the existing app.
