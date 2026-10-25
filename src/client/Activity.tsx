import { Activity, ArrowUpRight, CheckCircle2, MessageCircle, Sparkles } from 'lucide-react';
import type { Snapshot } from '../shared/schema.js';
import { time } from './api.js';

export function ActivityView({
  data,
  online,
  onSync,
}: {
  data: Snapshot;
  online: boolean;
  onSync: () => void;
}) {
  return (
    <div className="settings-page">
      <span className="eyebrow">Behind the scenes</span>
      <h1>Activity</h1>
      <p className="page-description">From arriving messages to clear next steps.</p>
      <section className="settings-card">
        <div className="card-title">
          <Activity size={22} />
          <div>
            <h2>{data.status.phase}</h2>
            <p>
              {!online
                ? 'The workspace server is unreachable. We’ll keep trying.'
                : (data.status.error ??
                  (data.demo
                    ? 'A sample workspace. No live chats or AI calls.'
                    : 'Your workspace server is available.'))}
            </p>
          </div>
          <button
            className="button secondary"
            disabled={data.status.syncing || data.demo}
            onClick={onSync}
          >
            {data.status.syncing ? 'Analysing…' : 'Find tasks now'}
            <ArrowUpRight size={15} />
          </button>
        </div>
      </section>
      <div className="activity-grid">
        <section className="settings-card">
          <MessageCircle size={21} />
          <h2>Message receipt</h2>
          <p>Last signed event</p>
          <strong>
            {data.status.last_webhook ? time(data.status.last_webhook) : 'No event recorded yet'}
          </strong>
        </section>
        <section className="settings-card">
          <CheckCircle2 size={21} />
          <h2>Task analysis</h2>
          <p>Last completed analysis</p>
          <strong>
            {data.status.last_extract ? time(data.status.last_extract) : 'No analysis recorded yet'}
          </strong>
          <p>
            {data.status.pending} messages pending
            {data.status.debouncing ? ' · Waiting for a quiet moment' : ''}
          </p>
        </section>
      </div>
      {data.status.last_decision && (
        <section className="settings-card">
          <h2>Latest processing decision · {data.status.last_decision.choice}</h2>
          <p>{data.status.last_decision.reason}</p>
          <span className="label">{data.status.last_decision.connection}</span>
        </section>
      )}
      <section className="settings-card">
        <div className="card-title">
          <Sparkles size={21} />
          <div>
            <h2>Model usage</h2>
            <p>
              {data.usage.calls.toLocaleString()} calls · {data.usage.totalTokens.toLocaleString()}{' '}
              tokens recorded
            </p>
          </div>
          <span className="label">{data.usage.model || 'No model used yet'}</span>
        </div>
        <p>Provider billing and subscription limits are managed by your provider.</p>
      </section>
    </div>
  );
}
