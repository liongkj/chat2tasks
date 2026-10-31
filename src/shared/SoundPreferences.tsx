import { useEffect, useState } from 'react';
import type { SoundPreferences } from './schema.js';
import { playSound, type SoundKind } from './sound.js';
import { errorMessage } from './errors.js';

export function SoundPreferencesEditor({
  value,
  onSave,
}: {
  value: SoundPreferences;
  onSave: (value: SoundPreferences) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    setDraft(value);
  }, [value.completion, value.attention, value.volume]);
  async function preview(kind: SoundKind) {
    const played = await playSound(kind, draft, true);
    setMessage(played ? '' : 'Sound is unavailable or the volume is set to zero.');
  }
  async function save() {
    setBusy(true);
    setMessage('');
    try {
      await onSave(draft);
      setMessage('Sound settings saved.');
    } catch (error) {
      setMessage(errorMessage(error, 'Could not save sound settings.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="sound-preferences">
      <label>
        <input
          type="checkbox"
          checked={draft.completion}
          disabled={busy}
          onChange={(event) => {
            setMessage('');
            setDraft({ ...draft, completion: event.target.checked });
          }}
        />
        <span>Task completion sound</span>
      </label>
      <label>
        <input
          type="checkbox"
          checked={draft.attention}
          disabled={busy}
          onChange={(event) => {
            setMessage('');
            setDraft({ ...draft, attention: event.target.checked });
          }}
        />
        <span>Clarification sound</span>
      </label>
      <label className="sound-volume">
        <span>Volume: {Math.round(draft.volume * 100)}%</span>
        <input
          aria-label="Sound volume"
          type="range"
          min="0"
          max="100"
          value={Math.round(draft.volume * 100)}
          disabled={busy}
          onChange={(event) => {
            setMessage('');
            setDraft({ ...draft, volume: Number(event.target.value) / 100 });
          }}
        />
      </label>
      <div className="sound-actions">
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void preview('completion')}
        >
          Preview completion
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void preview('attention')}
        >
          Preview clarification
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save sound settings'}
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
