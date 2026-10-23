import { useEffect, useState } from 'react';
import { Copy, Download, Link2, LoaderCircle, ShieldCheck, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { DevicesSchema, PairCodeSchema } from '../shared/companion.js';
import { api, OkSchema, time } from './api.js';
import { errorMessage } from './App.js';

export function CompanionSettings({ notify }: { notify: (message: string) => void }) {
  const [devices, setDevices] = useState<z.infer<typeof DevicesSchema>['devices']>([]);
  const [pairing, setPairing] = useState<z.infer<typeof PairCodeSchema> | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api('extensions', DevicesSchema)
      .then((result) => setDevices(result.devices))
      .catch((error) => notify(errorMessage(error)));
  }, [notify]);
  async function createCode() {
    setBusy(true);
    try {
      setPairing(await api('extensions/pairing', PairCodeSchema, {}));
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    try {
      setDevices((await api('extensions', DevicesSchema)).devices);
    } catch (error) {
      notify(errorMessage(error));
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
          <p>Your tasks, beside WhatsApp Web. Pair a browser with this workspace.</p>
        </div>
      </div>
      <ol className="companion-steps">
        <li>
          <a className="text-button" href="/downloads/chat2tasks-chrome.zip" download>
            <Download size={14} /> Download Chrome extension
          </a>
          <p>
            Unzip it. Open <strong>chrome://extensions</strong>, enable Developer mode, choose{' '}
            <strong>Load unpacked</strong>, and select the unzipped folder.
          </p>
        </li>
        <li>
          <p>
            Pin Chat2Tasks in Chrome. Open its side panel, enter this server’s address, and paste a
            pairing code below.
          </p>
        </li>
      </ol>
      <div className="connection-actions">
        <button className="button secondary" disabled={busy} onClick={() => void createCode()}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <Link2 size={14} />} Create pairing
          code
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
                  .catch(() => notify('Select the pairing code and copy it manually.'));
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
                  .catch((error) => notify(errorMessage(error)))
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
