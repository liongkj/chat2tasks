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
    const timer = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void invoke('retry_remote_workspace')
        .then(() => setError(''))
        .catch(() => setError('Could not retry. Try again.'))
        .finally(() => setAttempt((current) => current + 1));
    }, 10000);
    return () => clearTimeout(timer);
  }, [attempt]);

  async function retry() {
    setRetrying(true);
    setError('');
    try {
      await invoke('retry_remote_workspace');
    } catch (reason) {
      setError(typeof reason === 'string' ? reason : 'Could not retry. Try again.');
    } finally {
      setAttempt((current) => current + 1);
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
            ? 'Still trying automatically. Check that your server and network are on.'
            : 'Opening your workspace. We’ll keep trying automatically.'}
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
