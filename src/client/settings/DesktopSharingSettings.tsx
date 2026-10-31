import type { Notify } from '../../shared/useNotice.js';
import { useEffect, useState } from 'react';
import { Server } from 'lucide-react';
import { z } from 'zod';
import { api } from '../api.js';
import { errorMessage } from '../../shared/errors.js';
import { DesktopSharingStatusSchema } from '../../shared/desktop-sharing.js';

export function DesktopSharingSettings({ notify }: { notify: Notify }) {
  const [status, setStatus] = useState<z.infer<typeof DesktopSharingStatusSchema> | null>(null);
  const [origin, setOrigin] = useState('');
  const [port, setPort] = useState(2786);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api('desktop/sharing', DesktopSharingStatusSchema)
      .then((value) => {
        setStatus(value);
        if (value.configured.kind === 'enabled') {
          setOrigin(value.configured.origin);
          setPort(value.configured.port);
        }
      })
      .catch((error) => notify(errorMessage(error)));
  }, [notify]);
  async function save(kind: 'enabled' | 'disabled') {
    setBusy(true);
    try {
      const value = await api(
        'desktop/sharing',
        DesktopSharingStatusSchema,
        kind === 'enabled' ? { kind, origin: origin.trim(), port, password } : { kind },
      );
      setStatus(value);
      setPassword('');
      notify(
        value.restartRequired
          ? 'Saved. Quit and reopen the app to apply sharing.'
          : 'Sharing saved.',
      );
    } catch (error) {
      notify(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const configured = status?.configured;
  const httpsPort = configured?.kind === 'enabled' ? new URL(configured.origin).port || '443' : '';
  return (
    <section className="settings-card">
      <div className="card-title">
        <span className="card-icon green">
          <Server size={20} />
        </span>
        <div>
          <h2>Connect other computers</h2>
          <p>
            Share this workspace through a private HTTPS address. This computer must stay awake.
          </p>
        </div>
      </div>
      {status && (
        <>
          <div className="field">
            <label htmlFor="sharing-origin">Private HTTPS address</label>
            <input
              id="sharing-origin"
              type="url"
              autoComplete="url"
              placeholder="https://your-server.tailnet.ts.net:8443"
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
            />
            <small>Use the address provided by Tailscale Serve or your private HTTPS proxy.</small>
          </div>
          <div className="field">
            <label htmlFor="sharing-port">Local server port</label>
            <input
              id="sharing-port"
              type="number"
              min={1024}
              max={65535}
              value={port}
              onChange={(event) => setPort(Number(event.target.value))}
            />
          </div>
          <div className="field">
            <label htmlFor="sharing-password">Workspace password</label>
            <input
              id="sharing-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <small>
              Use at least 12 characters. Enter the password again when changing sharing.
            </small>
          </div>
          {configured?.kind === 'enabled' && (
            <div className="field">
              <label>Private network setup</label>
              <small>
                Check <code>tailscale serve status</code> first and use a free HTTPS port. Then run
                this on the server computer:
              </small>
              <code>{`tailscale serve --bg --https=${httpsPort} http://127.0.0.1:${configured.port}`}</code>
              <small>
                Install Tailscale on each computer and connect them to the same tailnet.
              </small>
            </div>
          )}
          {status.restartRequired && (
            <p role="status">
              {status.unavailableReason === 'port_in_use'
                ? 'Sharing is off because the local port is in use. Choose another port, then quit and reopen Wawa.'
                : 'Quit Wawa from its menu or tray, then reopen it to apply this change.'}
            </p>
          )}
          <div className="card-footer">
            {configured?.kind === 'enabled' ? (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void save('disabled')}
              >
                Stop sharing
              </button>
            ) : (
              <span />
            )}
            <button
              className="button primary"
              disabled={
                busy || !origin.trim() || password.length < 12 || port < 1024 || port > 65535
              }
              onClick={() => void save('enabled')}
            >
              {busy
                ? 'Saving…'
                : configured?.kind === 'enabled'
                  ? 'Update sharing'
                  : 'Enable sharing'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
