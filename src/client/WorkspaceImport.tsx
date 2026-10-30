import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { LoaderCircle } from 'lucide-react';

export function WorkspaceImport({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [selected, setSelected] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState<'choosing' | 'importing' | null>(null);
  const [error, setError] = useState('');

  function changeOpen(next: boolean) {
    if (busy) return;
    if (!next) {
      setSelected(false);
      setPassphrase('');
      setError('');
    }
    onOpenChange(next);
  }
  async function choose() {
    setError('');
    setBusy('choosing');
    try {
      setSelected((await window.chat2tasksDesktop?.chooseImport()) ?? false);
    } catch {
      setError('Could not open the file picker. Please try again.');
    } finally {
      setBusy(null);
    }
  }
  async function restore() {
    setError('');
    setBusy('importing');
    try {
      const result = await window.chat2tasksDesktop?.importWorkspace(passphrase);
      if (!result?.ok) throw new Error(result?.error ?? 'Could not import this workspace.');
      setPassphrase('');
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not import this workspace.');
      setBusy(null);
    }
  }
  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Viewport className="modal-viewport">
          <Dialog.Popup className="modal workspace-import-dialog">
            <Dialog.Title>Import your workspace</Dialog.Title>
            <Dialog.Description>
              In your other workspace, open Settings → Move your workspace and download a transfer
              file.
            </Dialog.Description>
            <p>
              Your current workspace on this computer will be saved as a backup. After import,
              you’ll review your connections again.
            </p>
            <button
              className="button secondary"
              disabled={busy !== null}
              onClick={() => void choose()}
            >
              {busy === 'choosing'
                ? 'Opening files…'
                : selected
                  ? 'Change transfer file'
                  : 'Choose transfer file'}
            </button>
            {selected && (
              <>
                <p className="workspace-import-selected">Transfer file selected</p>
                <div className="field">
                  <label htmlFor="workspace-import-passphrase">Transfer passphrase</label>
                  <input
                    id="workspace-import-passphrase"
                    type="password"
                    autoComplete="off"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                  />
                </div>
              </>
            )}
            {busy === 'importing' && (
              <p role="status" className="workspace-import-progress">
                <LoaderCircle className="spin" size={16} /> Importing your workspace. This can take
                a moment.
              </p>
            )}
            {error && (
              <p role="alert" className="onboarding-error">
                {error}
              </p>
            )}
            <div className="workspace-import-actions">
              <Dialog.Close className="button ghost" disabled={busy !== null}>
                Cancel
              </Dialog.Close>
              <button
                className="button primary"
                disabled={!selected || passphrase.length < 8 || busy !== null}
                onClick={() => void restore()}
              >
                {busy === 'importing' ? 'Importing…' : 'Import workspace'}
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
