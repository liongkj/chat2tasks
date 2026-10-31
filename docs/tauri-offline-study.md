# Tauri and browser-free WhatsApp preview

The Tauri preview uses a separate application identifier and data directory. It does not open the
existing Electron workspace or reuse its WhatsApp session. An encrypted workspace transfer can be
selected explicitly; the previous preview workspace is kept as a backup.

The Tauri preview uses a bundled Bun runtime for its supervisor, app service, gateway and transfer
process. The existing Electron build retains its Node runtime and separate data directory.

On the target Mac, Windows, or Linux machine, install Node 24, Bun 1.4.4 or newer, Rust and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
Run `npm run tauri:stage` once to prepare the isolated runtime and browser, then run
`npm run tauri:build -- --bundles app` on macOS or `npm run tauri:build -- --bundles nsis` on
Windows. On Linux x64, run `npm run tauri:build -- --bundles deb` to build a Debian package.
The staging step downloads dependencies for the computer doing the build; it does not use an
existing app workspace. Build Intel and Apple Silicon Mac apps on their respective architectures.
The pinned WhatsApp browser does not currently provide a Linux ARM64 build, so the Linux desktop
preview requires x64.

On macOS, the following command tests the staged Bun services with fictional data and non-local
outbound network access blocked:

```sh
sandbox-exec -f scripts/baileys-offline.sb node scripts/test-tauri-runtime.mjs
```

It exercises the sample workspace, an unlinked gateway, the separate Codex installation check,
encrypted export, failed and successful import, and preservation of the old preview workspace as
a backup. The Windows workflow applies firewall rules to the installed preview before running the
same check.

For an isolated interface sample, start the preview with `--sample`. This uses fictional data and
does not start a WhatsApp gateway or synchronize messages.

## Desktop memory comparison

Before the switch to Bun, both windows displayed the same Overview and fictional tasks on one Mac. Five interleaved macOS
physical-footprint samples gave a median of 132 MB for an Electron sample window and its helpers,
and 121 MB for the Tauri window and its WebKit helpers. Including the local sample service and the
Tauri supervisor, the medians were 187 MB for Electron and 205 MB for Tauri; the Tauri samples ranged
from 205 to 227 MB. The Electron comparison used a minimal shell around the same interface, not the
full shipping app. The Tauri supervisor was a separate Node process that used about 24 MB in one
sample. Neither sample included a WhatsApp gateway or a running Codex process.

These are point-in-time sample measurements on a busy Mac, not a prediction of either app's full
connected memory use. The Tauri preview still contains the existing WhatsApp browser and runtime.

After switching the Tauri runtime to Bun 1.4.3, a separate run of the same fictional Overview used a
median physical footprint of 178 MB across five samples (178–181 MB), including its supervisor,
service and WebKit helpers. The earlier Node and later Bun readings were taken at different times;
neither included the WhatsApp gateway or a running Codex process.

## Offline WhatsApp evidence

The browser-free OpenWA engine was tested in a temporary directory with non-local outbound network
connections blocked by macOS. The gateway reported `baileys` as its active engine and zero sessions.
OpenWA's existing offline inbound-message suite passed 13 cases, including text, images, edits and
reactions; it uses the real Baileys parser but does not download media or contact WhatsApp.

To repeat the synthetic parser workload on a Mac after `npm run mac:prepare`, run:

```sh
CHAT2TASKS_OPENWA_SOURCE="$PWD/work/openwa-source" \
  sandbox-exec -f scripts/baileys-offline.sb \
  node --import ./scripts/baileys-offline-workload.mjs -e 'console.log("Offline workload complete")'
```

The command requires the prepared OpenWA source and runs under a macOS sandbox that blocks outbound
network access except localhost. The script does not start a gateway, create a session, persist
messages, or download media. For the 310 MB sample below, the same workload was preloaded into a
separate, unlinked Baileys gateway process.

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
