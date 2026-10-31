import type { Notify } from '../shared/useNotice.js';
import { useState } from 'react';
import { GtdSchema, TaskEvidenceSchema, type Gtd, type Task } from '../shared/schema.js';
import { api } from './api.js';
import { errorMessage } from '../shared/errors.js';

export function GtdEditor({
  task,
  onSaved,
  notify,
}: {
  task: Task;
  onSaved: () => void;
  notify: Notify;
}) {
  const [draft, setDraft] = useState<Gtd>(task.gtd);
  const [frequency, setFrequency] = useState(task.gtd.recurrence?.frequency ?? 'none');
  const [nextDate, setNextDate] = useState(task.gtd.recurrence?.next_date ?? '');
  const [saving, setSaving] = useState(false);
  async function save() {
    const previous = task.gtd.recurrence;
    const recurrence =
      frequency === 'none'
        ? null
        : {
            frequency,
            anchor_date:
              previous && previous.frequency === frequency && previous.next_date === nextDate
                ? previous.anchor_date
                : nextDate,
            next_date: nextDate,
          };
    const parsed = GtdSchema.safeParse({ ...draft, recurrence });
    if (!parsed.success) {
      notify('Add a valid date for repeating work and complete any date details.', 'error');
      return;
    }
    setSaving(true);
    try {
      await api('tasks/gtd', TaskEvidenceSchema, { id: task.id, gtd: parsed.data });
      onSaved();
      notify('Organization saved');
    } catch (error) {
      notify(errorMessage(error, 'Could not save organization.'), 'error');
    } finally {
      setSaving(false);
    }
  }
  return (
    <details className="detail-section gtd-editor">
      <summary>Organize</summary>
      <div className="gtd-fields">
        <label>
          Commitment
          <select
            value={draft.commitment}
            onChange={(event) =>
              setDraft({
                ...draft,
                commitment: event.target.value === 'someday' ? 'someday' : 'active',
              })
            }
          >
            <option value="active">Active</option>
            <option value="someday">Someday / Maybe</option>
          </select>
        </label>
        <label>
          Project <span className="field-hint">optional</span>
          <input
            value={draft.project ?? ''}
            onChange={(event) => setDraft({ ...draft, project: event.target.value || null })}
            placeholder="Group related work"
          />
        </label>
        <label>
          Area of responsibility <span className="field-hint">optional</span>
          <input
            value={draft.area ?? ''}
            onChange={(event) => setDraft({ ...draft, area: event.target.value || null })}
            placeholder="e.g. Operations"
          />
        </label>
        {draft.times.map((entry, index) => (
          <div className="gtd-time" key={index}>
            <label>
              Meaning
              <select
                value={entry.kind}
                onChange={(event) => {
                  const kind =
                    event.target.value === 'scheduled'
                      ? 'scheduled'
                      : event.target.value === 'revisit'
                        ? 'revisit'
                        : 'due';
                  setDraft({
                    ...draft,
                    times: draft.times.map((item, i) => (i === index ? { ...item, kind } : item)),
                  });
                }}
              >
                <option value="due">Due by</option>
                <option value="scheduled">Scheduled for</option>
                <option value="revisit">Revisit after</option>
              </select>
            </label>
            <label>
              As stated
              <input
                value={entry.text}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    times: draft.times.map((item, i) =>
                      i === index ? { ...item, text: event.target.value } : item,
                    ),
                  })
                }
                placeholder="e.g. next Friday"
              />
            </label>
            <label>
              Date <span className="field-hint">if known</span>
              <input
                type="date"
                value={entry.date ?? ''}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    times: draft.times.map((item, i) =>
                      i === index ? { ...item, date: event.target.value || null } : item,
                    ),
                  })
                }
              />
            </label>
            <button
              className="text-button"
              type="button"
              onClick={() =>
                setDraft({ ...draft, times: draft.times.filter((_, i) => i !== index) })
              }
            >
              Remove date
            </button>
          </div>
        ))}
        {draft.times.length < 6 && (
          <button
            className="text-button"
            type="button"
            onClick={() =>
              setDraft({ ...draft, times: [...draft.times, { kind: 'due', text: '', date: null }] })
            }
          >
            Add date or reminder
          </button>
        )}
        {(task.kind === 'task' || task.kind === 'action') && (
          <div className="gtd-repeat">
            <label>
              Repeat
              <select
                value={frequency}
                onChange={(event) => {
                  const value = event.target.value;
                  setFrequency(
                    value === 'daily' ||
                      value === 'weekly' ||
                      value === 'monthly' ||
                      value === 'yearly'
                      ? value
                      : 'none',
                  );
                }}
              >
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </label>
            {frequency !== 'none' && (
              <label>
                Next occurrence
                <input
                  type="date"
                  value={nextDate}
                  onChange={(event) => setNextDate(event.target.value)}
                />
              </label>
            )}
          </div>
        )}
        <p className="field-hint">
          Dates and reminders appear in the app. No notification is sent.
        </p>
        <button
          className="button secondary"
          type="button"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save organization'}
        </button>
      </div>
    </details>
  );
}
