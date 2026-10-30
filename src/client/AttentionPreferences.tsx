import type { AttentionPreferences } from '../shared/schema.js';

export function AttentionPreferencesEditor({
  value,
  onChange,
}: {
  value: AttentionPreferences;
  onChange: (value: AttentionPreferences) => void;
}) {
  return (
    <div className="attention-preferences">
      <label className="preference-row">
        <span>
          <strong>How much should appear?</strong>
          <small>Unclear ownership always stays reviewable.</small>
        </span>
        <select
          value={value.sensitivity}
          onChange={(event) =>
            onChange({
              ...value,
              sensitivity: event.target.value === 'broader' ? 'broader' : 'focused',
            })
          }
        >
          <option value="focused">Only clear work</option>
          <option value="broader">Include possible work for review</option>
        </select>
      </label>
      <label className="preference-row">
        <span>
          <strong>Operational screenshots</strong>
          <small>For example, a screenshot of a full disk.</small>
        </span>
        <select
          value={value.screenshots}
          onChange={(event) =>
            onChange({ ...value, screenshots: event.target.value === 'review' ? 'review' : 'task' })
          }
        >
          <option value="task">Treat as a task</option>
          <option value="review">Ask me to review</option>
        </select>
      </label>
      <label className="preference-row">
        <span>
          <strong>Reminders</strong>
          <small>Keep useful heads-up messages in the app.</small>
        </span>
        <input
          type="checkbox"
          checked={value.includeReminders}
          onChange={(event) => onChange({ ...value, includeReminders: event.target.checked })}
        />
      </label>
      <label className="preference-row">
        <span>
          <strong>Waiting for</strong>
          <small>Track things you have asked someone else to provide.</small>
        </span>
        <input
          type="checkbox"
          checked={value.trackWaiting}
          onChange={(event) => onChange({ ...value, trackWaiting: event.target.checked })}
        />
      </label>
      <label className="preference-row">
        <span>
          <strong>When a reply looks complete</strong>
          <small>Separate unfinished work stays open.</small>
        </span>
        <select
          value={value.resolveReplies}
          onChange={(event) =>
            onChange({
              ...value,
              resolveReplies: event.target.value === 'review' ? 'review' : 'automatically',
            })
          }
        >
          <option value="automatically">Resolve clear matches</option>
          <option value="review">Ask me to confirm</option>
        </select>
      </label>
    </div>
  );
}
