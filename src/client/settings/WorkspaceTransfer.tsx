import type { Notify } from '../../shared/useNotice.js';
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { appFetch } from '../api.js';
import { errorMessage } from '../../shared/errors.js';

export function WorkspaceTransfer({ notify, onImport }: { notify: Notify; onImport?: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const mismatch = confirmation.length > 0 && confirmation !== passphrase;
  async function downloadTransfer() {
    setBusy(true);
    try {
      const response = await appFetch('/api/workspace/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase }),
      });
      if (!response.ok) throw new Error('Could not create the workspace transfer.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'chat2tasks-workspace.c2t';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setPassphrase('');
      setConfirmation('');
      notify('Encrypted workspace transfer downloaded.');
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card">
      <div className="card-title">
        <span className="card-icon green">
          <ShieldCheck size={20} />
        </span>
        <div>
          <h2>Move your workspace</h2>
          <p>
            Save tasks, notes, conversations, cached images and saved model keys in an encrypted
            file. This does not move your WhatsApp server or its linked session.
          </p>
        </div>
      </div>
      <div className="field">
        <label htmlFor="transfer-passphrase">Create a passphrase</label>
        <input
          id="transfer-passphrase"
          type="password"
          autoComplete="new-password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
        />
        <small>
          Use at least eight characters. You will need this passphrase on your new computer.
        </small>
      </div>
      <div className="field">
        <label htmlFor="transfer-passphrase-confirm">Repeat the passphrase</label>
        <input
          id="transfer-passphrase-confirm"
          type="password"
          autoComplete="new-password"
          value={confirmation}
          aria-invalid={mismatch || undefined}
          aria-describedby={mismatch ? 'transfer-passphrase-mismatch' : undefined}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        {mismatch && (
          <small id="transfer-passphrase-mismatch" role="alert" className="field-error">
            The passphrases do not match.
          </small>
        )}
      </div>
      <div className="card-footer">
        <span>Your transfer file is encrypted.</span>
        <button
          className="button secondary"
          disabled={busy || passphrase.length < 8 || confirmation !== passphrase}
          onClick={() => void downloadTransfer()}
        >
          {busy ? 'Preparing…' : 'Download transfer'}
        </button>
      </div>
      {onImport && (
        <div className="workspace-import-option">
          <div>
            <strong>Bring an existing workspace to this computer</strong>
            <p>Choose an encrypted transfer from your other workspace.</p>
          </div>
          <button className="button secondary" onClick={onImport}>
            Import workspace
          </button>
        </div>
      )}
    </section>
  );
}
