import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './workspace-picker.css';

type WorkspaceTarget =
  { kind: 'unconfigured' } | { kind: 'local' } | { kind: 'remote'; url: string };
type WorkspaceChoice = 'local' | 'remote' | 'move';
type MoveResult = { ok: true; kind: 'complete' | 'ack_pending' } | { ok: false; error: string };

export function WorkspacePicker() {
  const [kind, setKind] = useState<WorkspaceChoice | null>(null);
  const [address, setAddress] = useState('');
  const [sourcePassword, setSourcePassword] = useState('');
  const [targetOrigin, setTargetOrigin] = useState('');
  const [targetPassword, setTargetPassword] = useState('');
  const [localPort, setLocalPort] = useState(2786);
  const [moveResult, setMoveResult] = useState<'complete' | 'ack_pending' | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void invoke<WorkspaceTarget>('get_workspace_target')
      .then((target) => {
        setKind(target.kind === 'unconfigured' ? null : target.kind);
        if (target.kind === 'remote') setAddress(target.url);
      })
      .catch(() => setError('Could not read the saved workspace choice. Choose where to work.'))
      .finally(() => setLoading(false));
  }, []);

  async function connect() {
    if (!kind) return;
    setSaving(true);
    setError('');
    try {
      if (kind === 'move') {
        if (moveResult === 'complete') {
          await invoke('set_workspace_target', { target: { kind: 'local' } });
          return;
        }
        const result = await invoke<MoveResult>('move_workspace', {
          sourceOrigin: address.trim(),
          sourcePassword,
          targetOrigin: targetOrigin.trim(),
          localPort,
          targetPassword,
        });
        if (!result.ok) throw new Error(result.error);
        setMoveResult(result.kind);
        setSaving(false);
        return;
      }
      const target: WorkspaceTarget = kind === 'local' ? { kind } : { kind, url: address };
      await invoke('set_workspace_target', { target });
    } catch (reason) {
      setError(
        typeof reason === 'string'
          ? reason
          : reason instanceof Error
            ? reason.message
            : 'Could not switch workspaces. Try again.',
      );
      setSaving(false);
    }
  }

  let targetHttpsPort = '';
  try {
    const parsed = new URL(targetOrigin);
    if (parsed.protocol === 'https:') targetHttpsPort = parsed.port || '443';
  } catch {
    /* The address is still being entered. */
  }

  return (
    <main className="workspace-picker">
      <p className="workspace-picker-eyebrow">WAWA WORKSPACE</p>
      <h1>Where should work happen?</h1>
      <p>Choose where your workspace runs. Other computers can connect to the same server.</p>
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
            <small>Run a workspace on this computer while it is awake.</small>
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
            <strong>Another server</strong>
            <small>Connect to a workspace that already runs on another computer.</small>
          </span>
        </label>
        <label className={kind === 'move' ? 'selected' : ''}>
          <input
            type="radio"
            name="workspace"
            checked={kind === 'move'}
            onChange={() => setKind('move')}
          />
          <span>
            <strong>Move an existing workspace here</strong>
            <small>Make this computer the server and stop the previous server.</small>
          </span>
        </label>
      </div>
      {(kind === 'remote' || kind === 'move') && (
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
            Use a private Tailscale HTTPS address or another secure address for your running Wawa
            workspace.
          </small>
        </div>
      )}
      {kind === 'move' && (
        <div className="workspace-picker-address">
          <label htmlFor="move-source-password">Current workspace password</label>
          <input
            id="move-source-password"
            type="password"
            autoComplete="current-password"
            value={sourcePassword}
            onChange={(event) => setSourcePassword(event.target.value)}
          />
          <label htmlFor="move-target-origin">This computer’s private HTTPS address</label>
          <input
            id="move-target-origin"
            type="url"
            placeholder="https://this-computer.tailnet.ts.net:8443"
            value={targetOrigin}
            onChange={(event) => setTargetOrigin(event.target.value)}
          />
          <label htmlFor="move-target-port">Local server port</label>
          <input
            id="move-target-port"
            type="number"
            min={1024}
            max={65535}
            value={localPort}
            onChange={(event) => setLocalPort(Number(event.target.value))}
          />
          <label htmlFor="move-target-password">New workspace password</label>
          <input
            id="move-target-password"
            type="password"
            autoComplete="new-password"
            value={targetPassword}
            onChange={(event) => setTargetPassword(event.target.value)}
          />
          <small>
            Use at least 12 characters. Keep both computers on and connected during the move.
          </small>
          {targetHttpsPort && (
            <small>
              For Tailscale Serve, check that the HTTPS port is free, then run on this computer:{' '}
              <code>{`tailscale serve --bg --https=${targetHttpsPort} http://127.0.0.1:${localPort}`}</code>
            </small>
          )}
          <small>
            The previous workspace on this computer is kept as a backup. Reconnect WhatsApp and
            Codex after the move.
          </small>
          <small>
            If this computer is running a local workspace, switch it to the current server first.
          </small>
        </div>
      )}
      <p className="workspace-picker-note">
        {kind === 'move'
          ? 'The old server stops accepting work before this computer takes over. This is a planned move, not automatic failover.'
          : 'Choose one server for each workspace. Switching does not move tasks or WhatsApp sessions.'}
      </p>
      {error && (
        <p role="alert" className="workspace-picker-error">
          {error}
        </p>
      )}
      {moveResult === 'ack_pending' && kind === 'move' && (
        <p role="status">
          The workspace moved here. The old server is safely stopped but has not confirmed the move.
          Retry confirmation, or open the workspace here.
        </p>
      )}
      {moveResult === 'complete' && kind === 'move' && (
        <p role="status">
          The move is complete. Restart Wawa on the old computer and point other computers to this
          computer’s new address. Reconnect WhatsApp and Codex here.
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
        {moveResult === 'ack_pending' && kind === 'move' && (
          <button
            className="button secondary"
            disabled={saving}
            onClick={() => void invoke('set_workspace_target', { target: { kind: 'local' } })}
          >
            Open workspace here
          </button>
        )}
        <button
          className="button primary"
          disabled={
            loading ||
            saving ||
            !kind ||
            ((kind === 'remote' || kind === 'move') && !address.trim()) ||
            (kind === 'move' &&
              (!sourcePassword ||
                !targetOrigin.trim() ||
                targetPassword.length < 12 ||
                localPort < 1024 ||
                localPort > 65535))
          }
          onClick={() => void connect()}
        >
          {saving
            ? kind === 'move'
              ? 'Moving workspace…'
              : 'Opening workspace…'
            : moveResult === 'complete' && kind === 'move'
              ? 'Open workspace here'
              : moveResult === 'ack_pending' && kind === 'move'
                ? 'Retry confirmation'
                : kind === 'move'
                  ? 'Move workspace here'
                  : kind === 'remote'
                    ? 'Use server workspace'
                    : kind === 'local'
                      ? 'Use this computer'
                      : 'Choose a workspace'}
        </button>
      </div>
    </main>
  );
}
