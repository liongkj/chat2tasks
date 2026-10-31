import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './workspace-picker.css';

type WorkspaceTarget = { kind: 'local' } | { kind: 'remote'; url: string };

export function WorkspacePicker() {
  const [kind, setKind] = useState<WorkspaceTarget['kind']>('local');
  const [address, setAddress] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void invoke<WorkspaceTarget>('get_workspace_target')
      .then((target) => {
        setKind(target.kind);
        if (target.kind === 'remote') setAddress(target.url);
      })
      .catch(() => setError('Could not read the saved workspace choice. Choose where to work.'))
      .finally(() => setLoading(false));
  }, []);

  async function connect() {
    setSaving(true);
    setError('');
    try {
      const target: WorkspaceTarget = kind === 'local' ? { kind } : { kind, url: address };
      await invoke('set_workspace_target', { target });
    } catch (reason) {
      setError(typeof reason === 'string' ? reason : 'Could not switch workspaces. Try again.');
      setSaving(false);
    }
  }

  return (
    <main className="workspace-picker">
      <p className="workspace-picker-eyebrow">WAWA WORKSPACE</p>
      <h1>Where should work happen?</h1>
      <p>Choose the workspace you want to use. You can switch again at any time.</p>
      <div className="workspace-picker-options" role="radiogroup" aria-label="Workspace location">
        <label className={kind === 'local' ? 'selected' : ''}>
          <input
            type="radio"
            name="workspace"
            checked={kind === 'local'}
            onChange={() => setKind('local')}
          />
          <span>
            <strong>This computer</strong>
            <small>Work is processed while this computer is awake.</small>
          </span>
        </label>
        <label className={kind === 'remote' ? 'selected' : ''}>
          <input
            type="radio"
            name="workspace"
            checked={kind === 'remote'}
            onChange={() => setKind('remote')}
          />
          <span>
            <strong>Always-on server</strong>
            <small>Work can continue while this computer sleeps or is closed.</small>
          </span>
        </label>
      </div>
      {kind === 'remote' && (
        <div className="workspace-picker-address">
          <label htmlFor="workspace-server">Wawa server address</label>
          <input
            id="workspace-server"
            type="url"
            autoComplete="url"
            placeholder="https://your-server.tailnet.ts.net"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <small>
            Use a private Tailscale HTTPS address or another secure address for your running
            Wawa workspace.
          </small>
        </div>
      )}
      <p className="workspace-picker-note">
        This computer and the server are separate workspaces. Switching does not move tasks or
        WhatsApp sessions.
      </p>
      {error && (
        <p role="alert" className="workspace-picker-error">
          {error}
        </p>
      )}
      <div className="workspace-picker-actions">
        <button
          className="button secondary"
          disabled={saving}
          onClick={() => void invoke('close_workspace_picker')}
        >
          Cancel
        </button>
        <button
          className="button primary"
          disabled={loading || saving || (kind === 'remote' && !address.trim())}
          onClick={() => void connect()}
        >
          {saving
            ? 'Opening workspace…'
            : kind === 'remote'
              ? 'Use server workspace'
              : 'Use this computer'}
        </button>
      </div>
    </main>
  );
}
