import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { LoaderCircle } from 'lucide-react';
import './workspace-picker.css';

export function RemoteConnecting() {
  const [attempt, setAttempt] = useState(0);
  const [slow, setSlow] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(timer);
  }, [attempt]);

  async function retry() {
    setRetrying(true);
    setError('');
    try {
      await invoke('retry_remote_workspace');
      setAttempt((current) => current + 1);
    } catch (reason) {
      setError(typeof reason === 'string' ? reason : 'Could not retry. Try again.');
    } finally {
      setRetrying(false);
    }
  }

  return (
    <main className="remote-connecting">
      <div className="remote-connecting-card">
        <LoaderCircle className="spin" size={24} aria-hidden="true" />
        <h1>Connecting to your server</h1>
        <p role="status">
          {slow
            ? 'Taking longer than expected. Check that your server and private connection are on.'
            : 'Opening your workspace. This can take a moment.'}
        </p>
        {error && (
          <p className="remote-connecting-error" role="alert">
            {error}
          </p>
        )}
        <div className="remote-connecting-actions">
          <button className="button secondary" disabled={retrying} onClick={() => void retry()}>
            {retrying ? 'Trying again…' : 'Retry connection'}
          </button>
          <button
            className="button secondary"
            onClick={() =>
              void invoke('open_workspace_picker').catch(() =>
                setError('Could not open workspace choices.'),
              )
            }
          >
            Switch workspace
          </button>
        </div>
      </div>
    </main>
  );
}
