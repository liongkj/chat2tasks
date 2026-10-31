import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  LoaderCircle,
  MessageCircle,
  Sparkles,
} from 'lucide-react';
import type { Snapshot } from '../shared/schema.js';
import { time } from './api.js';

export function ActivityView({
  data,
  online,
  requestingSync,
  onSync,
}: {
  data: Snapshot;
  online: boolean;
  requestingSync: boolean;
  onSync: () => void;
}) {
  const working = requestingSync || data.status.syncing || data.status.debouncing;
  const phase = !online
    ? 'Reconnecting to your workspace'
    : data.status.error
      ? 'Something needs your attention'
      : requestingSync
        ? 'Starting analysis…'
        : data.status.phase === 'Listening for OpenWA events'
          ? 'Waiting for new messages'
          : data.status.phase;
  return (
    <div className="settings-page">
      <span className="eyebrow">Behind the scenes</span>
      <h1>Activity</h1>
      <p className="page-description">From arriving messages to clear next steps.</p>
      <section className="settings-card">
        <div className="card-title">
          {working ? <LoaderCircle className="spin" size={22} /> : <Activity size={22} />}
          <div role="status" aria-live="polite">
            <h2>{phase}</h2>
            <p>
              {!online
                ? 'The workspace server is unreachable. We’ll keep trying.'
                : (data.status.error ??
                  (working
                    ? 'This can take a moment. You can keep using Wawa.'
                    : data.demo
                      ? 'A sample workspace. No live chats or AI calls.'
                      : data.messages.length === 0
                        ? 'No messages are saved in this workspace yet.'
                        : 'Your workspace is up to date.'))}
            </p>
          </div>
          <button
            className="button secondary"
            disabled={working || data.demo || !online}
            onClick={onSync}
          >
            {requestingSync
              ? 'Starting…'
              : data.status.syncing
                ? 'Checking messages…'
                : data.status.debouncing
                  ? 'Waiting…'
                  : 'Find tasks now'}
            <ArrowUpRight size={15} />
          </button>
        </div>
      </section>
      <div className="activity-grid">
        <section className="settings-card">
          <MessageCircle size={21} />
          <h2>Message receipt</h2>
          <p>Last connection update</p>
          <strong>
            {data.status.last_webhook ? time(data.status.last_webhook) : 'No event recorded yet'}
          </strong>
        </section>
        <section className="settings-card">
          <CheckCircle2 size={21} />
          <h2>Task analysis</h2>
          <p>Last completed check</p>
          <strong>
            {data.status.last_extract ? time(data.status.last_extract) : 'No analysis recorded yet'}
          </strong>
          <p>
            {data.status.pending} {data.status.pending === 1 ? 'message' : 'messages'} waiting
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
              {data.usage.calls.toLocaleString()} {data.usage.calls === 1 ? 'call' : 'calls'} ·{' '}
              {data.usage.totalTokens.toLocaleString()} tokens recorded
            </p>
          </div>
          <span className="label">{data.usage.model || 'No model used yet'}</span>
        </div>
        <p>Provider billing and subscription limits are managed by your provider.</p>
      </section>
    </div>
  );
}
