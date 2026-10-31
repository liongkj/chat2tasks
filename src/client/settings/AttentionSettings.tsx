import type { Notify } from '../../shared/useNotice.js';
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { AttentionPreferencesSchema, type AttentionPreferences } from '../../shared/schema.js';
import { api } from '../api.js';
import { errorMessage } from '../../shared/errors.js';
import { AttentionPreferencesEditor } from '../AttentionPreferences.js';

export function AttentionSettings({ notify }: { notify: Notify }) {
  const [value, setValue] = useState<AttentionPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api('preferences', AttentionPreferencesSchema)
      .then(setValue)
      .catch((error) => notify(errorMessage(error), 'error'));
  }, [notify]);
  async function save() {
    if (!value) return;
    setBusy(true);
    try {
      setValue(await api('preferences', AttentionPreferencesSchema, value));
      notify('Attention preferences saved.');
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card">
      <div className="card-title">
        <span className="card-icon">
          <Sparkles size={20} />
        </span>
        <div>
          <h2>What needs attention</h2>
          <p>Choose how new conversation evidence is organized.</p>
        </div>
      </div>
      {value && <AttentionPreferencesEditor value={value} onChange={setValue} />}
      <div className="card-footer">
        <span>Existing items and your corrections stay in place.</span>
        <button className="button secondary" disabled={!value || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save preferences'}
        </button>
      </div>
    </section>
  );
}
