import type { Notify } from '../shared/useNotice.js';
import { useEffect, useState } from 'react';
import { Copy, Download, Link2, LoaderCircle, ShieldCheck, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { DevicesSchema, PairCodeSchema } from '../shared/companion.js';
import { api, appFetch, OkSchema, time } from './api.js';
import { errorMessage } from '../shared/errors.js';

export function CompanionSettings({ notify }: { notify: Notify }) {
  const [devices, setDevices] = useState<z.infer<typeof DevicesSchema>['devices']>([]);
  const [pairing, setPairing] = useState<z.infer<typeof PairCodeSchema> | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api('extensions', DevicesSchema)
      .then((result) => setDevices(result.devices))
      .catch((error) => notify(errorMessage(error), 'error'));
  }, [notify]);
  async function createCode() {
    setBusy(true);
    try {
      setPairing(await api('extensions/pairing', PairCodeSchema, {}));
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    try {
      setDevices((await api('extensions', DevicesSchema)).devices);
    } catch (error) {
      notify(errorMessage(error), 'error');
    }
  }
  async function downloadExtension() {
    try {
      const response = await appFetch('/downloads/chat2tasks-chrome.zip');
      if (!response.ok) throw new Error('Could not download the extension.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'chat2tasks-chrome.zip';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      notify(errorMessage(error), 'error');
    }
  }
  return (
    <section className="settings-card" id="chrome-companion">
      <div className="card-title">
        <span className="card-icon">
          <Link2 size={20} />
        </span>
        <div>
          <h2>Chrome companion</h2>
          <p>
            Quiet TODO links and topic threads in WhatsApp Web. Pair a browser with this workspace.
          </p>
        </div>
      </div>
      <ol className="companion-steps">
        <li>
          {window.chat2tasksTauri ? (
            <button className="text-button" onClick={() => void downloadExtension()}>
              <Download size={14} /> Download Chrome extension
            </button>
          ) : (
            <a className="text-button" href="/downloads/chat2tasks-chrome.zip" download>
              <Download size={14} /> Download Chrome extension
            </a>
          )}
          <p>
            Unzip it. Open <strong>chrome://extensions</strong>, enable Developer mode, choose{' '}
            <strong>Load unpacked</strong>, and select the unzipped folder. For Edge, use{' '}
            <strong>edge://extensions</strong>.
          </p>
        </li>
        <li>
          <p>
            Pin Wawa in Chrome. Open its side panel, enter this server’s address, and paste a
            pairing code below. Allow access to WhatsApp Web, then refresh that tab to see Chats and
            Threads.
          </p>
          <label htmlFor="companion-address">Workspace address</label>
          <div className="secret-input">
            <input
              id="companion-address"
              value={window.chat2tasksTauri?.origin ?? window.location.origin}
              readOnly
              spellCheck={false}
            />
            <button
              className="icon-btn"
              aria-label="Copy workspace address"
              onClick={() => {
                void navigator.clipboard
                  .writeText(window.chat2tasksTauri?.origin ?? window.location.origin)
                  .then(() => notify('Workspace address copied'))
                  .catch(() => notify('Select the address and copy it manually.'));
              }}
            >
              <Copy size={15} />
            </button>
          </div>
        </li>
      </ol>
      <p className="muted">
        Updating an existing installation? Replace the files in its current extension folder, reload
        the extension, and refresh WhatsApp Web. Keeping the folder preserves its pairing.
      </p>
      <div className="connection-actions">
        <button className="button secondary" disabled={busy} onClick={() => void createCode()}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <Link2 size={14} />}{' '}
          {busy ? 'Creating pairing code…' : 'Create pairing code'}
        </button>
        <button className="text-button" onClick={() => void refresh()}>
          Refresh paired browsers
        </button>
      </div>
      {pairing && (
        <div className="companion-pairing">
          <label htmlFor="companion-code">One-time pairing code</label>
          <div className="secret-input">
            <input id="companion-code" value={pairing.code} readOnly spellCheck={false} />
            <button
              className="icon-btn"
              aria-label="Copy pairing code"
              onClick={() => {
                void navigator.clipboard
                  .writeText(pairing.code)
                  .then(() => notify('Pairing code copied'))
                  .catch(() => notify('Select the pairing code and copy it manually.', 'error'));
              }}
            >
              <Copy size={15} />
            </button>
          </div>
          <small>Expires {time(pairing.expiresAt)}. Creating another code replaces this one.</small>
        </div>
      )}
      <div className="companion-devices">
        {devices.map((device) => (
          <div className="companion-device" key={device.id}>
            <div>
              <strong>{device.name}</strong>
              <small>
                Paired {time(device.created)} ·{' '}
                {device.lastUsed ? 'Last used ' + time(device.lastUsed) : 'Not used yet'}
              </small>
            </div>
            <button
              className="text-button danger-text"
              disabled={busy}
              aria-label={`Revoke ${device.name}`}
              onClick={() => {
                setBusy(true);
                void api('extensions/' + encodeURIComponent(device.id) + '/revoke', OkSchema, {})
                  .then(async () => {
                    await refresh();
                    notify('Browser access revoked');
                  })
                  .catch((error) => notify(errorMessage(error), 'error'))
                  .finally(() => setBusy(false));
              }}
            >
              <Trash2 size={13} /> Revoke
            </button>
          </div>
        ))}
        {!devices.length && <p className="companion-no-devices">No browsers paired yet.</p>}
      </div>
      <div className="codex-hint">
        <ShieldCheck size={16} />
        <p>
          Each browser gets a revocable connection, valid for 90 days. Model API keys stay on this
          server. The extension saves only text you review and submit.
        </p>
      </div>
    </section>
  );
}
