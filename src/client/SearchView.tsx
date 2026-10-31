import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import type { Chat, Message, Task } from '../shared/schema.js';
import {
  SearchResponseSchema,
  SearchSettingsSchema,
  type SearchResponse,
  type SearchSettings,
} from '../shared/search.js';
import { api, time } from './api.js';
import { conversationName } from './conversations.js';

function excerpt(text: string, query: string) {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  const found = trimmed.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = Math.max(0, found - 50);
  return `${start ? '…' : ''}${trimmed.slice(start, start + 180)}${trimmed.length > start + 180 ? '…' : ''}`;
}

export function SearchView({
  tasks,
  messages,
  chats,
  query,
  onQuery,
  onTask,
  onMessage,
  navigationTrigger,
}: {
  tasks: Task[];
  messages: Message[];
  chats: Chat[];
  query: string;
  onQuery: (query: string) => void;
  onTask: (task: Task) => void;
  onMessage: (message: Message, chat: Chat) => void;
  navigationTrigger: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState<SearchSettings | null>(null);
  const [draft, setDraft] = useState<SearchSettings>({ kind: 'workspace' });
  const [serverUrl, setServerUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const consumedRetry = useRef(0);
  const sourceRevision = useMemo(() => JSON.stringify([tasks, messages]), [tasks, messages]);

  useEffect(() => {
    input.current?.focus();
    void api('search/settings', SearchSettingsSchema)
      .then((current) => {
        setSettings(current);
        setDraft(current);
        if (current.kind === 'server') setServerUrl(current.url);
      })
      .catch(() => setError('Could not load search settings.'));
  }, []);
  useEffect(() => {
    if (!query.trim() || !settings) {
      setResult(null);
      setBusy(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setBusy(true);
    setResult(null);
    setError('');
    const run = async (first: boolean) => {
      try {
        const retryNow = first && retry > consumedRetry.current;
        if (retryNow) consumedRetry.current = retry;
        const found = await api('search', SearchResponseSchema, {
          query: query.trim(),
          retry: retryNow,
        });
        if (cancelled) return;
        setResult(found);
        setBusy(false);
        if (found.status.kind === 'indexing' || found.media?.kind === 'indexing')
          timer = setTimeout(() => void run(false), 1000);
      } catch {
        if (!cancelled) {
          setBusy(false);
          setError('Search could not be completed. Try again.');
        }
      }
    };
    timer = setTimeout(() => void run(true), 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, settings, sourceRevision, retry]);

  async function saveSettings() {
    const parsed = SearchSettingsSchema.safeParse(
      draft.kind === 'workspace' ? draft : { kind: 'server', url: serverUrl.trim() },
    );
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid server address.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const saved = await api('search/settings', SearchSettingsSchema, parsed.data);
      setDraft(saved);
      setSettings(saved);
      setRetry(0);
      consumedRetry.current = 0;
    } catch {
      setError('Could not save the search server. Try again.');
    } finally {
      setSaving(false);
    }
  }
  type Row =
    | { kind: 'task'; id: string; match: 'exact' | 'related'; task: Task }
    | { kind: 'message'; id: string; match: 'exact' | 'related'; message: Message };
  const resultRows: Row[] = [];
  for (const row of result?.results ?? []) {
    if (row.kind === 'task') {
      const task = tasks.find((item) => item.id === row.id);
      if (task) resultRows.push({ ...row, kind: 'task', task });
    } else {
      const message = messages.find((item) => item.id === row.id);
      if (message) resultRows.push({ ...row, kind: 'message', message });
    }
  }
  return (
    <section className="workspace-search" aria-label="Spotlight">
      <div className="page-heading">
        {navigationTrigger}
        <h1>Spotlight</h1>
      </div>
      <p className="search-intro">
        Find saved items, messages, images, audio and video by their words or meaning.
      </p>
      <label className="task-search workspace-search-input">
        <Search size={17} />
        <input
          ref={input}
          aria-label="Search workspace"
          placeholder="Search items and messages"
          maxLength={500}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
        {query && (
          <button
            className="icon-btn"
            aria-label="Clear workspace search"
            onClick={() => {
              onQuery('');
              input.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        )}
      </label>
      <details className="search-settings">
        <summary>Search model and server</summary>
        <p>
          Related results use EmbeddingGemma 2 through Ollama. Audio is indexed in short clips and
          video as sampled frames and audio. By default, the models and search index stay on your
          workspace machine.
        </p>
        <label>
          <input
            type="radio"
            name="search-server"
            checked={draft.kind === 'workspace'}
            onChange={() => setDraft({ kind: 'workspace' })}
          />{' '}
          This workspace machine
        </label>
        <label>
          <input
            type="radio"
            name="search-server"
            checked={draft.kind === 'server'}
            onChange={() => setDraft({ kind: 'server', url: serverUrl })}
          />{' '}
          Another Ollama server
        </label>
        {draft.kind === 'server' && (
          <>
            <label className="search-server-label">
              Server address
              <input
                type="url"
                value={serverUrl}
                placeholder="https://your-search-server"
                onChange={(event) => setServerUrl(event.target.value)}
              />
            </label>
            <p>
              Task details, saved messages, attachments and search queries are sent to this server.
              Use a server you trust and an encrypted connection when traffic leaves this machine.
            </p>
          </>
        )}
        <p>
          Install Ollama on the machine running the search model, then run{' '}
          <code>ollama pull embeddinggemma-2:270m-q8_0-text</code> and{' '}
          <code>ollama pull embeddinggemma-2:740m-q8_0</code>.
        </p>
        <button
          className="button secondary"
          disabled={saving || !settings}
          onClick={() => void saveSettings()}
        >
          {saving ? 'Saving…' : 'Save search server'}
        </button>
      </details>
      {query.trim() && (
        <div className="search-status" role="status" aria-live="polite">
          {busy
            ? 'Searching…'
            : result?.status.kind === 'indexing'
              ? `Preparing related results · ${result.status.indexed} of ${result.status.total}`
              : result?.status.kind === 'unavailable'
                ? 'Exact matches are available. Start Ollama and download EmbeddingGemma 2 for related results.'
                : result?.status.kind === 'ready'
                  ? 'Search complete'
                  : ''}
          {result?.media?.kind === 'indexing' && (
            <span>
              {' '}
              · Preparing media · {result.media.indexed} of {result.media.total}
            </span>
          )}
          {result?.media?.kind === 'unavailable' && (
            <span>
              {' '}
              · Some media could not be indexed. Check the model, FFmpeg and attachments.
            </span>
          )}
          {(result?.status.kind === 'unavailable' || result?.media?.kind === 'unavailable') && (
            <button className="text-button" onClick={() => setRetry((value) => value + 1)}>
              Retry
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="search-error">
          {error}
        </p>
      )}
      {resultRows.length > 0 && (
        <div className="search-results">
          {(['exact', 'related'] as const).map((match) => {
            const rows = resultRows.filter((row) => row.match === match);
            if (!rows.length) return null;
            return (
              <section
                key={match}
                aria-label={match === 'exact' ? 'Exact matches' : 'Related results'}
              >
                <h2>{match === 'exact' ? 'Exact matches' : 'Related results'}</h2>
                {rows.map((row) => {
                  if ('task' in row)
                    return (
                      <button
                        className="search-result"
                        key={`task:${row.id}`}
                        onClick={() => onTask(row.task)}
                      >
                        <span className="search-result-meta">
                          Item · {row.task.reference} ·{' '}
                          {conversationName(row.task, messages, chats)}
                        </span>
                        <strong>{row.task.title}</strong>
                        <span>
                          {excerpt(
                            [
                              row.task.note,
                              row.task.own_remark,
                              ...row.task.action_steps,
                              ...row.task.done_when,
                            ].join(' '),
                            query,
                          )}
                        </span>
                      </button>
                    );
                  const chat = chats.find(
                    (item) =>
                      item.chatId === row.message.chatId &&
                      item.sessionId === row.message.sessionId,
                  );
                  const messageText = [
                    row.message.body,
                    ...(row.message.image_reading?.observations ?? []),
                    ...(row.message.image_reading?.uncertainties ?? []),
                  ].filter(Boolean);
                  const mediaLabel =
                    row.message.type === 'image'
                      ? 'Image'
                      : row.message.type === 'video'
                        ? 'Video'
                        : ['audio', 'ptt'].includes(row.message.type)
                          ? 'Audio'
                          : 'Message';
                  const bestText =
                    messageText.find((value) =>
                      value.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
                    ) ??
                    messageText[0] ??
                    `Saved ${mediaLabel.toLowerCase()}`;
                  const content = (
                    <>
                      <span className="search-result-meta">
                        {mediaLabel} · {chat?.name ?? 'Saved conversation'} ·{' '}
                        {time(row.message.timestamp)}
                      </span>
                      <strong>{excerpt(bestText, query)}</strong>
                    </>
                  );
                  return chat ? (
                    <button
                      className="search-result"
                      key={`message:${row.id}`}
                      onClick={() => onMessage(row.message, chat)}
                    >
                      {content}
                    </button>
                  ) : (
                    <div className="search-result" key={`message:${row.id}`}>
                      {content}
                    </div>
                  );
                })}
                {match === 'exact' && result?.moreExact && (
                  <p className="empty-copy">
                    Showing the first 50 matches. Add more words to narrow the search.
                  </p>
                )}
              </section>
            );
          })}
        </div>
      )}
      {!busy &&
        query.trim() &&
        result &&
        !resultRows.length &&
        result.status.kind !== 'indexing' && (
          <p className="empty-copy">
            {result.status.kind === 'unavailable'
              ? 'No exact matches. Related search is not available yet.'
              : 'No matching items or messages. Try a different search.'}
          </p>
        )}
    </section>
  );
}
