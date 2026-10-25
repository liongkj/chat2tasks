import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  EyeOff,
  KeyRound,
  LoaderCircle,
  MessageSquare,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
  Cloud,
} from 'lucide-react';
import { z } from 'zod';
import {
  PublicSettingsSchema,
  type Chat,
  type Profile,
  type PublicSettings,
  type Settings,
} from '../shared/schema.js';
import { api, OkSchema } from './api.js';
import { errorMessage } from './App.js';
import { CompanionSettings } from './CompanionSettings.js';

type Props = {
  tab: 'chats' | 'models';
  config: PublicSettings;
  onSave: (config: PublicSettings) => void;
  notify: (text: string) => void;
};
type DiscoveredEntry = { id: string; name: string };
export function SettingsPanel({ tab, config, onSave, notify }: Props) {
  const [draft, setDraft] = useState(config.settings),
    [secrets, setSecrets] = useState<Record<string, string>>({}),
    [remove, setRemove] = useState<string[]>([]);
  const [saving, setSaving] = useState(false),
    [addingChat, setAddingChat] = useState(false),
    [addingModel, setAddingModel] = useState(false);
  const [discovering, setDiscovering] = useState(false),
    [sessionId, setSessionId] = useState(''),
    [sessions, setSessions] = useState<DiscoveredEntry[]>([]),
    [discovered, setDiscovered] = useState<{ sessionId: string; chats: DiscoveredEntry[] } | null>(
      null,
    ),
    [discoveryError, setDiscoveryError] = useState('');
  async function save(settings: Settings = draft, credentialChanges = secrets, removed = remove) {
    setSaving(true);
    try {
      const next = await api('settings', PublicSettingsSchema, {
        settings,
        secrets: credentialChanges,
        removeSecrets: removed,
      });
      onSave(next);
      setDraft(next.settings);
      setSecrets({});
      setRemove([]);
      notify('Workspace settings saved');
      return true;
    } catch (e) {
      notify(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  }
  function credential(id: string, label: string) {
    const exists = config.configuredSecrets.includes(id) && !remove.includes(id);
    return (
      <div className="field credential-field">
        <label htmlFor={'secret-' + id}>
          {label}
          {exists && (
            <span className="saved-key">
              <ShieldCheck size={11} /> Saved securely
            </span>
          )}
        </label>
        <div className="secret-input">
          <KeyRound size={14} />
          <input
            id={'secret-' + id}
            type="password"
            autoComplete="new-password"
            value={secrets[id] ?? ''}
            placeholder={exists ? '•••••••••••• · leave blank to keep' : 'Paste a key…'}
            onChange={(e) => {
              setSecrets({ ...secrets, [id]: e.target.value });
              setRemove(remove.filter((key) => key !== id));
            }}
          />
          <EyeOff size={14} />
        </div>
        {exists && (
          <button
            className="text-button danger-text"
            onClick={() => {
              setRemove([...remove, id]);
              setSecrets({ ...secrets, [id]: '' });
            }}
          >
            Remove saved key
          </button>
        )}
        {remove.includes(id) && (
          <small className="danger-text">Key will be removed when you save.</small>
        )}
      </div>
    );
  }
  async function discover(session?: string) {
    setDiscovering(true);
    setDiscoveryError('');
    try {
      if (!(await save())) return;
      const entries = await api(
        'discover',
        z.array(z.object({ id: z.string(), name: z.string() })),
        session ? { sessionId: session } : {},
      );
      if (session) setDiscovered({ sessionId: session, chats: entries });
      else {
        setSessions(entries);
        setDiscovered(null);
        setSessionId((current) =>
          entries.some((entry) => entry.id === current)
            ? current
            : entries.length === 1
              ? entries[0]!.id
              : '',
        );
      }
      if (!entries.length)
        notify('No conversations found. You can add one by session and chat ID.');
    } catch (e) {
      const message = errorMessage(e);
      setDiscoveryError(message);
      notify(message);
    } finally {
      setDiscovering(false);
    }
  }
  async function toggle(chat: Chat) {
    const next = {
      ...config.settings,
      chats: config.settings.chats.map((c) =>
        c.id === chat.id ? { ...c, enabled: !c.enabled } : c,
      ),
    };
    await save(next, {}, []);
  }
  const activeCount = draft.chats.filter((c) => c.enabled).length;
  return (
    <div className="settings-page">
      <div className="settings-page-heading">
        <div>
          <h1>{tab === 'chats' ? 'Connections' : 'Settings'}</h1>
          <p className="page-description">
            {tab === 'chats'
              ? 'Connect WhatsApp and choose which conversations to follow.'
              : 'Manage your models, API keys, and Chrome companion.'}
          </p>
        </div>
        <button className="button primary" onClick={() => void save()} disabled={saving}>
          {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />} Save changes
        </button>
      </div>
      {tab === 'chats' ? (
        <>
          <section className="settings-card">
            <div className="card-title">
              <span className="card-icon green">
                <MessageSquare size={20} />
              </span>
              <div>
                <h2>OpenWA connection</h2>
                <p>Your WhatsApp session, connected to your own server.</p>
              </div>
              <span className="label">No chat replies</span>
            </div>
            <div className="form-grid">
              <div className="field">
                <label htmlFor="openwa-url">OpenWA API URL</label>
                <input
                  id="openwa-url"
                  placeholder="http://openwa-api:2785"
                  value={draft.openwaUrl}
                  onChange={(e) => setDraft({ ...draft, openwaUrl: e.target.value })}
                />
                <small>Use the address reachable from this Docker container.</small>
              </div>
              {credential('openwa', 'OpenWA API key')}
            </div>
            <div className="card-footer">
              <span>
                <ShieldCheck size={13} /> Keys stay on your server.
              </span>
              <button
                className="button secondary"
                disabled={discovering || !draft.openwaUrl}
                onClick={() => void discover()}
              >
                {discovering ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <RefreshCw size={14} />
                )}{' '}
                Find sessions
              </button>
            </div>
          </section>
          <section className="settings-card">
            <div className="card-title">
              <span className="card-icon">
                <Radio size={20} />
              </span>
              <div>
                <h2>
                  Chat activator <span className="label">{activeCount} active</span>
                </h2>
                <p>Only active chats are sent to your selected AI connection.</p>
              </div>
              <button className="button secondary" onClick={() => setAddingChat(true)}>
                <Plus size={14} /> Add chat
              </button>
            </div>
            {sessions.length > 0 && (
              <div className="discovery-controls">
                <div className="field">
                  <label htmlFor="discover-session">WhatsApp session</label>
                  <select
                    id="discover-session"
                    value={sessionId}
                    onChange={(e) => setSessionId(e.target.value)}
                  >
                    <option value="">Choose a session…</option>
                    {sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  className="button secondary"
                  disabled={!sessionId || discovering}
                  onClick={() => void discover(sessionId)}
                >
                  Find chats <ChevronRight size={14} />
                </button>
              </div>
            )}
            {discovered?.sessionId === sessionId && discovered.chats.length > 0 && (
              <div className="discovered-list">
                {discovered.chats.map((c) => (
                  <div className="discovered-row" key={c.id}>
                    <MessageSquare size={15} />
                    <span>{c.name}</span>
                    <button
                      className="text-button"
                      disabled={draft.chats.some(
                        (chat) => chat.chatId === c.id && chat.sessionId === sessionId,
                      )}
                      onClick={() => {
                        setDraft({
                          ...draft,
                          chats: [
                            ...draft.chats,
                            {
                              id: crypto.randomUUID(),
                              name: c.name,
                              sessionId,
                              chatId: c.id,
                              enabled: false,
                            },
                          ],
                        });
                        notify('Chat added as paused. Save changes, then activate it when ready.');
                      }}
                    >
                      Add paused <Plus size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {draft.chats.length ? (
              <div className="chat-activators">
                {draft.chats.map((c) => (
                  <div className="chat-activator" key={c.id}>
                    <span className="conversation-avatar">{c.name.slice(0, 1)}</span>
                    <div className="activator-info">
                      <input
                        className="activator-name"
                        aria-label={`Conversation name: ${c.name}`}
                        value={c.name}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            chats: draft.chats.map((chat) =>
                              chat.id === c.id ? { ...chat, name: e.target.value } : chat,
                            ),
                          })
                        }
                      />
                      <p>
                        {c.enabled
                          ? 'Following this conversation'
                          : 'Paused · saved tasks remain available'}
                      </p>
                      <small>{c.chatId}</small>
                    </div>
                    <span className={`label ${c.enabled ? 'green-label' : ''}`}>
                      {c.enabled ? 'Active' : 'Paused'}
                    </span>
                    <button
                      className={`toggle ${c.enabled ? 'on' : ''}`}
                      role="switch"
                      aria-checked={c.enabled}
                      aria-label={`Activate ${c.name}`}
                      disabled={saving || !config.settings.chats.some((chat) => chat.id === c.id)}
                      onClick={() => void toggle(c)}
                    >
                      <span />
                    </button>
                    <button
                      className="icon-btn danger-text"
                      aria-label={`Remove ${c.name} from followed chats`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          chats: draft.chats.filter((chat) => chat.id !== c.id),
                        })
                      }
                    >
                      <X size={15} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="settings-empty">
                <MessageSquare size={26} />
                <h3>A good place to start</h3>
                <p>Add a conversation you want to follow. You control what’s active.</p>
                <button className="button secondary" onClick={() => setAddingChat(true)}>
                  <Plus size={14} /> Add a conversation
                </button>
              </div>
            )}
          </section>
          <section className="settings-card">
            <div className="card-title">
              <span className="card-icon">
                <Radio size={20} />
              </span>
              <div>
                <h2>Live message delivery</h2>
                <p>OpenWA sends signed events when a message arrives, changes, or is sent.</p>
              </div>
              <span className="label">
                {config.webhook.registeredSessions ? 'Registered' : 'Not connected'}
              </span>
            </div>
            <div className="field">
              <label htmlFor="webhook-url">Webhook callback URL</label>
              <input
                id="webhook-url"
                value={draft.webhookUrl}
                placeholder="http://chat2tasks:2786/api/webhooks/openwa"
                onChange={(e) => setDraft({ ...draft, webhookUrl: e.target.value })}
              />
              <small>
                Use the address reachable from OpenWA. Private hosts must be explicitly allowed in
                OpenWA’s SSRF host allowlist.
              </small>
            </div>
            <div className="card-footer">
              <span>
                {config.webhook.lastReceivedAt
                  ? 'Last signed event: ' +
                    new Date(config.webhook.lastReceivedAt * 1000).toLocaleString()
                  : 'No signed event received yet'}
              </span>
              <button
                className="button secondary"
                disabled={saving || !draft.webhookUrl || !draft.chats.length}
                onClick={async () => {
                  if (!(await save())) return;
                  setSaving(true);
                  try {
                    const next = await api('webhooks/connect', PublicSettingsSchema, {});
                    onSave(next);
                    notify('Webhooks connected. OpenWA delivered a signed test successfully.');
                  } catch (e) {
                    notify(errorMessage(e));
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                <Radio size={14} /> Connect & test webhooks
              </button>
            </div>
          </section>
          <div className="privacy-strip">
            <ShieldCheck size={18} />
            <p>
              Pausing a chat stops new AI processing. Existing tasks, ticks, notes, and cached
              messages stay available. Chat2Tasks never sends a reply to WhatsApp.
            </p>
          </div>
          <ChatDialog
            open={addingChat}
            onClose={() => {
              setAddingChat(false);
              setDiscoveryError('');
            }}
            sessions={sessions}
            sessionId={sessionId}
            onSessionChange={setSessionId}
            discovered={discovered?.sessionId === sessionId ? discovered.chats : null}
            discovering={discovering}
            discoveryError={discoveryError}
            canDiscover={Boolean(draft.openwaUrl)}
            onDiscoverSessions={() => discover()}
            onDiscoverChats={() => discover(sessionId)}
            existingChats={draft.chats}
            onAdd={async (chat) => {
              const next = { ...draft, chats: [...draft.chats, chat] };
              if (await save(next)) setAddingChat(false);
            }}
          />
        </>
      ) : (
        <>
          <section className="settings-card connection-explainer">
            <div className="card-title">
              <span className="card-icon">
                <Sparkles size={20} />
              </span>
              <div>
                <h2>Model connections</h2>
                <p>Use Codex, an OpenAI-compatible API, or a Cloudflare AI Gateway.</p>
              </div>
              <button className="button secondary" onClick={() => setAddingModel(true)}>
                <Plus size={14} /> Add connection
              </button>
            </div>
          </section>
          {draft.profiles.map((profile) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              active={draft.activeProfileId === profile.id}
              onActivate={() => {
                if (profile.kind !== 'decision')
                  setDraft({ ...draft, activeProfileId: profile.id });
              }}
              onChange={(updated) =>
                setDraft({
                  ...draft,
                  profiles: draft.profiles.map((p) => (p.id === updated.id ? updated : p)),
                })
              }
              onRemove={() => {
                if (draft.profiles.length === 1) return;
                const profiles = draft.profiles.filter((p) => p.id !== profile.id);
                const first = profiles.find((p) => p.kind !== 'decision');
                if (first)
                  setDraft({
                    ...draft,
                    profiles,
                    trigger:
                      draft.trigger.mode === 'automatic' &&
                      draft.trigger.decisionProfileId === profile.id
                        ? { mode: 'automatic', decisionProfileId: null }
                        : draft.trigger,
                    activeProfileId:
                      draft.activeProfileId === profile.id ? first.id : draft.activeProfileId,
                  });
              }}
              canRemove={
                profile.kind === 'decision' ||
                draft.profiles.filter((p) => p.kind !== 'decision').length > 1
              }
              credential={credential}
              onTest={async () => {
                if (await save()) {
                  await api('test-model', OkSchema, { profileId: profile.id });
                  notify('Connection works. This test used one small AI request.');
                }
              }}
              onModels={async () => {
                if (!(await save())) return [];
                const result = await api(
                  'models',
                  z.object({ models: z.array(z.string()), error: z.string().optional() }),
                  { profileId: profile.id },
                );
                if (result.error) notify(result.error);
                return result.models;
              }}
              notify={notify}
            />
          ))}
          <section className="settings-card">
            <div className="card-title">
              <span className="card-icon">
                <Zap size={20} />
              </span>
              <div>
                <h2>Give conversations a little room</h2>
                <p>Wait for a quiet moment before turning a burst of messages into tasks.</p>
              </div>
            </div>
            <div className="form-grid">
              <div className="field full-width">
                <label htmlFor="trigger-mode">When to run task analysis</label>
                <select
                  id="trigger-mode"
                  value={draft.trigger.mode}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      trigger:
                        e.target.value === 'manual'
                          ? { mode: 'manual' }
                          : { mode: 'automatic', decisionProfileId: draft.activeProfileId },
                    })
                  }
                >
                  <option value="automatic">Automatically · debounce, then decide</option>
                  <option value="manual">Only when I choose Run now</option>
                </select>
              </div>
              {draft.trigger.mode === 'automatic' && (
                <div className="field full-width">
                  <label htmlFor="decision-connection">Decision connection</label>
                  <select
                    id="decision-connection"
                    value={draft.trigger.decisionProfileId ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        trigger: { mode: 'automatic', decisionProfileId: e.target.value || null },
                      })
                    }
                  >
                    <option value="">No decision call · run after the quiet period</option>
                    {draft.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.model}
                      </option>
                    ))}
                  </select>
                  <small>
                    OpenAI Decisions, Jev, Codex, or another configured connection. Low confidence
                    and decision errors run the task model so evidence is retained.
                  </small>
                </div>
              )}
              <div className="field">
                <label>Message delivery</label>
                <div className="codex-hint">
                  <Radio size={16} />
                  <p>
                    OpenWA webhooks. Messages trigger work as they arrive; no periodic message
                    polling.
                  </p>
                </div>
              </div>
              <div className="field">
                <label htmlFor="quiet">Wait for a quiet period of</label>
                <select
                  id="quiet"
                  value={draft.quietSeconds}
                  onChange={(e) => setDraft({ ...draft, quietSeconds: Number(e.target.value) })}
                >
                  {[0, 15, 30, 45, 60, 120].map((v) => (
                    <option key={v} value={v}>
                      {v ? `${v} seconds` : 'Process immediately'}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>
          <div className="privacy-strip">
            <ShieldCheck size={18} />
            <p>
              API keys are encrypted on your server and never sent back to this browser.
              Conversations go only to your selected model connection. Keep the data volume and its
              vault key backed up together.
            </p>
          </div>
          <ModelDialog
            open={addingModel}
            onClose={() => setAddingModel(false)}
            onAdd={(profile) => {
              setDraft({ ...draft, profiles: [...draft.profiles, profile] });
              setAddingModel(false);
              notify('Connection added. Enter its details and save changes.');
            }}
          />
        </>
      )}
      {tab === 'models' && <CompanionSettings notify={notify} />}
      <div className="settings-save-bottom">
        <button className="button primary" disabled={saving} onClick={() => void save()}>
          <Check size={14} />
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        <span>Changes are saved to this workspace.</span>
      </div>
    </div>
  );
}

function ProfileCard({
  profile,
  active,
  onActivate,
  onChange,
  onRemove,
  canRemove,
  credential,
  onTest,
  onModels,
  notify,
}: {
  profile: Profile;
  active: boolean;
  onActivate: () => void;
  onChange: (profile: Profile) => void;
  onRemove: () => void;
  canRemove: boolean;
  credential: (id: string, label: string) => React.ReactNode;
  onTest: () => Promise<void>;
  onModels: () => Promise<string[]>;
  notify: (text: string) => void;
}) {
  const [testing, setTesting] = useState(false),
    [models, setModels] = useState<string[]>([]),
    [loading, setLoading] = useState(false);
  return (
    <section className={`settings-card profile-card ${active ? 'active-profile' : ''}`}>
      <div className="card-title">
        <span className="card-icon">
          {profile.kind === 'codex' ? (
            <Sparkles size={20} />
          ) : profile.kind === 'cloudflare' ? (
            <Cloud size={20} />
          ) : (
            <Server size={20} />
          )}
        </span>
        <div>
          <h2>{profile.name}</h2>
          <p>
            {profile.kind === 'codex'
              ? 'Your existing Codex subscription'
              : profile.kind === 'cloudflare'
                ? 'Cloudflare AI Gateway'
                : profile.kind === 'decision'
                  ? profile.provider === 'jev'
                    ? 'TypeSafe Jev · native decision API'
                    : 'OpenAI · native Decisions API'
                  : 'Any OpenAI-compatible endpoint'}
          </p>
        </div>
        <button className={`label label-button ${active ? 'purple' : ''}`} onClick={onActivate}>
          {profile.kind === 'decision' ? (
            'Decision only'
          ) : active ? (
            <>
              <Check size={11} /> In use
            </>
          ) : (
            'Use connection'
          )}
        </button>
        {canRemove && (
          <button
            className="icon-btn danger-text"
            aria-label={`Delete ${profile.name} connection`}
            onClick={onRemove}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`name-${profile.id}`}>Connection name</label>
          <input
            id={`name-${profile.id}`}
            value={profile.name}
            onChange={(e) => onChange({ ...profile, name: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={`model-${profile.id}`}>Model ID</label>
          <input
            id={`model-${profile.id}`}
            value={profile.model}
            list={`models-${profile.id}`}
            placeholder="Enter any model ID"
            onChange={(e) => onChange({ ...profile, model: e.target.value })}
          />
          <datalist id={`models-${profile.id}`}>
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <small>
            {profile.kind === 'cloudflare' && profile.route === 'unified'
              ? 'Use author/model, for example openai/gpt-4.1.'
              : 'Enter the exact model ID your connection supports.'}
          </small>
        </div>
        {(profile.kind === 'compatible' || profile.kind === 'decision') && (
          <>
            <div className="field">
              <label htmlFor={`url-${profile.id}`}>API base URL</label>
              <input
                id={`url-${profile.id}`}
                value={profile.baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(e) => onChange({ ...profile, baseUrl: e.target.value })}
              />
            </div>
            {credential(profile.id + ':key', 'Provider API key')}
          </>
        )}
        {profile.kind === 'cloudflare' && (
          <>
            <div className="field">
              <label htmlFor={`account-${profile.id}`}>Cloudflare account ID</label>
              <input
                id={`account-${profile.id}`}
                value={profile.accountId}
                onChange={(e) => onChange({ ...profile, accountId: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={`gateway-${profile.id}`}>Gateway ID</label>
              <input
                id={`gateway-${profile.id}`}
                value={profile.gatewayId}
                onChange={(e) => onChange({ ...profile, gatewayId: e.target.value })}
              />
            </div>
            <div className="field full-width">
              <label htmlFor={`route-${profile.id}`}>Routing</label>
              <select
                id={`route-${profile.id}`}
                value={profile.route}
                onChange={(e) =>
                  onChange({ ...profile, route: e.target.value === 'proxy' ? 'proxy' : 'unified' })
                }
              >
                <option value="proxy">Proxy · use your OpenAI provider key</option>
                <option value="unified">Cloudflare REST API · unified billing</option>
              </select>
            </div>
            {profile.route === 'proxy' &&
              credential(profile.id + ':key', 'OpenAI provider API key')}
            {credential(
              profile.id + ':gateway',
              profile.route === 'proxy'
                ? 'Gateway token (for authenticated gateways)'
                : 'Cloudflare token · Workers AI Read',
            )}
            <div className="connection-route full-width">
              <ShieldCheck size={14} />
              <span>
                Chat2Tasks <ChevronRight size={12} /> Cloudflare Gateway <ChevronRight size={12} />{' '}
                {profile.route === 'proxy' ? 'OpenAI' : 'Your selected model'}
              </span>
            </div>
          </>
        )}
      </div>
      {profile.kind === 'codex' && (
        <div className="codex-hint">
          <ShieldCheck size={16} />
          <p>
            Sign in to Codex inside the container once. Your session lives in the private{' '}
            <code>codex-home</code> volume. No API key is needed.
          </p>
        </div>
      )}
      <div className="card-footer">
        <a
          className="text-button"
          href={
            profile.kind === 'cloudflare'
              ? 'https://developers.cloudflare.com/ai-gateway/usage/rest-api/'
              : profile.kind === 'codex'
                ? 'https://developers.openai.com/codex/cli/'
                : 'https://github.com/liongkj/chat2tasks#model-connections'
          }
          target="_blank"
          rel="noreferrer"
        >
          Connection guide <ArrowUpRight size={12} />
        </a>
        <div className="form-inline">
          {profile.kind === 'compatible' && (
            <button
              className="button secondary"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                try {
                  setModels(await onModels());
                } catch (e) {
                  notify(errorMessage(e));
                } finally {
                  setLoading(false);
                }
              }}
            >
              {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} Load
              models
            </button>
          )}
          <button
            className="button secondary"
            disabled={testing}
            onClick={async () => {
              setTesting(true);
              try {
                await onTest();
              } catch (e) {
                notify(errorMessage(e));
              } finally {
                setTesting(false);
              }
            }}
          >
            {testing ? <LoaderCircle size={14} className="spin" /> : <Zap size={14} />} Test
            connection
          </button>
        </div>
      </div>
    </section>
  );
}
function ChatDialog({
  open,
  onClose,
  onAdd,
  sessions,
  sessionId,
  onSessionChange,
  discovered,
  discovering,
  discoveryError,
  canDiscover,
  onDiscoverSessions,
  onDiscoverChats,
  existingChats,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (chat: Chat) => Promise<void>;
  sessions: DiscoveredEntry[];
  sessionId: string;
  onSessionChange: (id: string) => void;
  discovered: DiscoveredEntry[] | null;
  discovering: boolean;
  discoveryError: string;
  canDiscover: boolean;
  onDiscoverSessions: () => Promise<void>;
  onDiscoverChats: () => Promise<void>;
  existingChats: Chat[];
}) {
  const [name, setName] = useState(''),
    [session, setSession] = useState(''),
    [id, setId] = useState(''),
    [selectedChat, setSelectedChat] = useState(''),
    [method, setMethod] = useState<'list' | 'manual'>('list'),
    [saving, setSaving] = useState(false);
  const selected = discovered?.find((chat) => chat.id === selectedChat);
  const duplicate =
    method === 'list' &&
    Boolean(selected) &&
    existingChats.some((chat) => chat.sessionId === sessionId && chat.chatId === selectedChat);
  return (
    <Dialog.Root
      open={open}
      onOpenChangeComplete={(next) => {
        if (!next) {
          setName('');
          setSession('');
          setId('');
          setSelectedChat('');
          setMethod('list');
        }
      }}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Viewport className="modal-viewport">
          <Dialog.Popup className="modal chat-dialog">
            <button
              className="icon-btn modal-close"
              onClick={onClose}
              aria-label="Close add conversation"
            >
              <X size={17} />
            </button>
            <span className="card-icon">
              <MessageSquare size={21} />
            </span>
            <Dialog.Title>Add a conversation</Dialog.Title>
            <Dialog.Description>Add it now. Activate it when you’re ready.</Dialog.Description>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (method === 'list' && (!selected || duplicate || !sessionId)) return;
                setSaving(true);
                try {
                  await onAdd({
                    id: crypto.randomUUID(),
                    name: name.trim(),
                    sessionId: method === 'list' ? sessionId : session.trim(),
                    chatId: method === 'list' ? selectedChat : id.trim(),
                    enabled: false,
                  });
                } finally {
                  setSaving(false);
                }
              }}
            >
              <div
                className="chat-add-method"
                role="group"
                aria-label="Choose a conversation source"
              >
                <button
                  type="button"
                  className={method === 'list' ? 'selected' : ''}
                  aria-pressed={method === 'list'}
                  onClick={() => setMethod('list')}
                >
                  Choose from list
                </button>
                <button
                  type="button"
                  className={method === 'manual' ? 'selected' : ''}
                  aria-pressed={method === 'manual'}
                  onClick={() => setMethod('manual')}
                >
                  Enter IDs manually
                </button>
              </div>
              {method === 'list' ? (
                <>
                  <div className="field">
                    <label htmlFor="chat-pick-session">OpenWA session</label>
                    <div className="chat-picker-row">
                      <select
                        id="chat-pick-session"
                        value={sessionId}
                        required
                        onChange={(e) => {
                          onSessionChange(e.target.value);
                          setSelectedChat('');
                          setName('');
                        }}
                      >
                        <option value="">Choose a session…</option>
                        {sessions.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => void onDiscoverSessions()}
                        disabled={discovering || !canDiscover}
                      >
                        {discovering ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : (
                          <RefreshCw size={14} />
                        )}
                        Find sessions
                      </button>
                    </div>
                    {!canDiscover && (
                      <small>Enter your OpenWA API URL above to find sessions.</small>
                    )}
                  </div>
                  <div className="field">
                    <label htmlFor="chat-pick-chat">WhatsApp chat</label>
                    <div className="chat-picker-row">
                      <select
                        id="chat-pick-chat"
                        value={selected ? selectedChat : ''}
                        required
                        disabled={!sessionId || discovered === null}
                        onChange={(e) => {
                          const choice = discovered?.find((chat) => chat.id === e.target.value);
                          setSelectedChat(e.target.value);
                          setName(choice?.name ?? '');
                        }}
                      >
                        <option value="">Choose a chat…</option>
                        {discovered?.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => void onDiscoverChats()}
                        disabled={!sessionId || discovering || !canDiscover}
                      >
                        {discovering ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : (
                          <RefreshCw size={14} />
                        )}
                        Find chats
                      </button>
                    </div>
                    {discovered?.length === 0 && <small>No chats found in this session.</small>}
                    {duplicate && (
                      <small className="danger-text">This chat is already added.</small>
                    )}
                  </div>
                  {discoveryError && (
                    <p className="chat-discovery-error" role="alert">
                      {discoveryError}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <div className="field">
                    <label htmlFor="chat-session">OpenWA session ID</label>
                    <input
                      id="chat-session"
                      value={session}
                      required
                      onChange={(e) => setSession(e.target.value)}
                      placeholder="Your connected session ID"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="chat-id">WhatsApp chat ID</label>
                    <input
                      id="chat-id"
                      value={id}
                      required
                      onChange={(e) => setId(e.target.value)}
                      placeholder="…@c.us, …@g.us, or …@lid"
                    />
                  </div>
                </>
              )}
              <div className="field">
                <label htmlFor="chat-name">Conversation name</label>
                <input
                  id="chat-name"
                  value={name}
                  required
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Design team"
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="button secondary" onClick={onClose}>
                  Cancel
                </button>
                <button
                  className="button primary"
                  disabled={saving || duplicate || (method === 'list' && (!sessionId || !selected))}
                >
                  {saving ? 'Adding…' : 'Add conversation'}
                  <Plus size={14} />
                </button>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function ModelDialog({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (profile: Profile) => void;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Viewport className="modal-viewport">
          <Dialog.Popup className="modal">
            <button
              className="icon-btn modal-close"
              onClick={onClose}
              aria-label="Close add connection"
            >
              <X size={17} />
            </button>
            <span className="card-icon">
              <Sparkles size={21} />
            </span>
            <Dialog.Title>Add a model connection</Dialog.Title>
            <Dialog.Description>Choose how this workspace connects to AI.</Dialog.Description>
            <div className="connection-options">
              <button
                onClick={() =>
                  onAdd({
                    id: crypto.randomUUID(),
                    name: 'OpenAI Decisions',
                    kind: 'decision',
                    provider: 'openai',
                    model: 'gpt-6-luna',
                    baseUrl: 'https://api.openai.com/v1',
                  })
                }
              >
                <Zap size={22} />
                <span>
                  <strong>OpenAI Decisions API</strong>
                  <small>Native typed decisions · API key required</small>
                </span>
                <ChevronRight size={16} />
              </button>
              <button
                onClick={() =>
                  onAdd({
                    id: crypto.randomUUID(),
                    name: 'Jev decision model',
                    kind: 'decision',
                    provider: 'jev',
                    model: 'jev-latest',
                    baseUrl: 'https://api.typesafe.ai/v1',
                  })
                }
              >
                <Radio size={22} />
                <span>
                  <strong>TypeSafe Jev</strong>
                  <small>Native System One decision API</small>
                </span>
                <ChevronRight size={16} />
              </button>
              <button
                onClick={() =>
                  onAdd({
                    id: crypto.randomUUID(),
                    name: 'Compatible API',
                    kind: 'compatible',
                    model: 'gpt-4.1-mini',
                    baseUrl: 'https://api.openai.com/v1',
                  })
                }
              >
                <Server size={22} />
                <span>
                  <strong>OpenAI-compatible API</strong>
                  <small>OpenAI, OpenRouter, Ollama, and more</small>
                </span>
                <ChevronRight size={16} />
              </button>
              <button
                onClick={() =>
                  onAdd({
                    id: crypto.randomUUID(),
                    name: 'Cloudflare Gateway',
                    kind: 'cloudflare',
                    model: 'gpt-4.1-mini',
                    accountId: '',
                    gatewayId: 'default',
                    route: 'proxy',
                  })
                }
              >
                <Cloud size={22} />
                <span>
                  <strong>Cloudflare AI Gateway</strong>
                  <small>Proxy your provider or use unified billing</small>
                </span>
                <ChevronRight size={16} />
              </button>
              <button
                onClick={() =>
                  onAdd({
                    id: crypto.randomUUID(),
                    name: 'Codex',
                    kind: 'codex',
                    model: 'gpt-6-luna',
                  })
                }
              >
                <Sparkles size={22} />
                <span>
                  <strong>Codex subscription</strong>
                  <small>Use a signed-in Codex session</small>
                </span>
                <ChevronRight size={16} />
              </button>
            </div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
