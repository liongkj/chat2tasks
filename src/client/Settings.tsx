import type { Notify } from '../shared/useNotice.js';
import { useEffect, useRef, useState } from 'react';

import {
  Check,
  ChevronRight,
  Eye,
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
  Volume2,
  X,
  Zap,
} from 'lucide-react';
import { z } from 'zod';
import {
  PublicSettingsSchema,
  type Chat,
  type PublicSettings,
  type Settings,
  type SoundPreferences,
} from '../shared/schema.js';
import { SoundPreferencesEditor } from '../shared/SoundPreferences.js';
import { api, OkSchema } from './api.js';
import { errorMessage } from '../shared/errors.js';
import { CompanionSettings } from './CompanionSettings.js';

import type { SettingsSection } from './taskLocation.js';
import { openWorkspacePicker } from './tauri.js';
import { DesktopSharingSettings } from './settings/DesktopSharingSettings.js';
import { AttentionSettings } from './settings/AttentionSettings.js';
import { WorkspaceTransfer } from './settings/WorkspaceTransfer.js';
import { ProfileCard } from './settings/ProfileCard.js';
import { ChatDialog, type DiscoveredEntry } from './settings/ChatDialog.js';
import { ModelDialog } from './settings/ModelDialog.js';

type Props = {
  section: SettingsSection;
  config: PublicSettings;
  sound: SoundPreferences;
  onSoundSave: (value: SoundPreferences) => Promise<void>;
  onSave: (config: PublicSettings) => void;
  notify: Notify;
  onImportWorkspace?: () => void;
  /** Reports whether the draft differs from what is saved, so the shell can guard navigation. */
  onDirty?: (dirty: boolean) => void;
};
const WhatsappStatus = z.object({ status: z.string(), qr: z.string().nullable() });
const sectionCopy: Record<SettingsSection, { title: string; description: string }> = {
  conversations: {
    title: 'WhatsApp & chats',
    description: 'Manage your WhatsApp server and choose which conversations to follow.',
  },
  models: { title: 'AI models', description: 'Choose and manage your AI connections.' },
  automation: {
    title: 'Automation',
    description: 'Choose when Wawa reviews new messages.',
  },
  attention: {
    title: 'Attention',
    description: 'Choose what appears in your workspace.',
  },
  workspace: {
    title: 'Workspaces',
    description: 'Choose where work happens or keep an encrypted backup.',
  },
  browser: {
    title: 'Browser companion',
    description: 'Connect the browser extension to this workspace.',
  },
};
export function SettingsPanel({
  section,
  config,
  sound,
  onSoundSave,
  onSave,
  notify,
  onImportWorkspace,
  onDirty,
}: Props) {
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    page.current?.scrollTo({ top: 0 });
  }, [section]);
  const [draft, setDraft] = useState(config.settings),
    [secrets, setSecrets] = useState<Record<string, string>>({}),
    [remove, setRemove] = useState<string[]>([]);
  const [shownSecrets, setShownSecrets] = useState<Set<string>>(() => new Set());
  const [pendingChat, setPendingChat] = useState<{
    id: string;
    action: 'pausing' | 'resuming';
  } | null>(null);
  const [whatsapp, setWhatsapp] = useState<z.infer<typeof WhatsappStatus> | null>(null);
  const [linkingWhatsapp, setLinkingWhatsapp] = useState(false);
  const [saving, setSaving] = useState(false),
    [addingChat, setAddingChat] = useState(false),
    [addingModel, setAddingModel] = useState(false);
  const [discovering, setDiscovering] = useState<'sessions' | 'chats' | null>(null),
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
      notify(errorMessage(e), 'error');
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
            type={shownSecrets.has(id) ? 'text' : 'password'}
            autoComplete="new-password"
            value={secrets[id] ?? ''}
            placeholder={exists ? '•••••••••••• · leave blank to keep' : 'Paste a key…'}
            onChange={(e) => {
              setSecrets({ ...secrets, [id]: e.target.value });
              setRemove(remove.filter((key) => key !== id));
            }}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label={shownSecrets.has(id) ? `Hide ${label}` : `Show ${label}`}
            aria-pressed={shownSecrets.has(id)}
            onClick={() =>
              setShownSecrets((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
          >
            {shownSecrets.has(id) ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
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
    setDiscovering(session ? 'chats' : 'sessions');
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
      notify(message, 'error');
    } finally {
      setDiscovering(null);
    }
  }
  async function toggle(chat: Chat) {
    const saved = config.settings.chats.find((item) => item.id === chat.id);
    if (!saved) return;
    const next = {
      ...config.settings,
      chats: config.settings.chats.map((c) =>
        c.id === chat.id ? { ...c, enabled: !saved.enabled } : c,
      ),
    };
    setPendingChat({ id: chat.id, action: saved.enabled ? 'pausing' : 'resuming' });
    setSaving(true);
    try {
      const updated = await api('settings', PublicSettingsSchema, {
        settings: next,
        secrets: {},
        removeSecrets: [],
      });
      onSave(updated);
      setDraft((current) => ({
        ...current,
        chats: current.chats.map((item) =>
          item.id === chat.id ? { ...item, enabled: !saved.enabled } : item,
        ),
      }));
      notify(`${chat.name} ${saved.enabled ? 'paused' : 'activated'}.`);
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setPendingChat(null);
      setSaving(false);
    }
  }
  const activeCount = draft.chats.filter((c) => c.enabled).length;
  const desktop = Boolean(window.chat2tasksDesktop || window.chat2tasksTauri);
  const gatewayPending =
    desktop &&
    (config.desktopGatewayRestartRequired ||
      draft.desktopGateway.mode !== config.settings.desktopGateway.activeMode ||
      (draft.desktopGateway.mode === 'local' &&
        draft.desktopGateway.engine !== config.settings.desktopGateway.activeEngine) ||
      (config.settings.desktopGateway.activeMode === 'remote' &&
        (draft.desktopGateway.remoteUrl !== config.settings.desktopGateway.remoteUrl ||
          Boolean(secrets['remote-openwa']?.trim()) ||
          remove.includes('remote-openwa'))));
  useEffect(() => {
    if (
      section !== 'conversations' ||
      !desktop ||
      gatewayPending ||
      config.settings.desktopGateway.activeMode !== 'local'
    )
      return;
    const refresh = () =>
      void api('desktop/whatsapp/status', WhatsappStatus)
        .then((next) => {
          setWhatsapp(next);
          if (['ready', 'failed', 'disconnected', 'action_required'].includes(next.status))
            setLinkingWhatsapp(false);
        })
        .catch(() => undefined);
    refresh();
    if (!linkingWhatsapp) return;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [
    section,
    desktop,
    gatewayPending,
    config.settings.desktopGateway.activeMode,
    linkingWhatsapp,
  ]);
  const savesSettings = ['conversations', 'models', 'automation'].includes(section);
  const hasChanges =
    JSON.stringify(draft) !== JSON.stringify(config.settings) ||
    Object.values(secrets).some((value) => value.trim().length > 0) ||
    remove.length > 0;
  useEffect(() => {
    onDirty?.(hasChanges);
    if (!hasChanges) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      onDirty?.(false);
    };
  }, [hasChanges, onDirty]);
  return (
    <div className="settings-page" ref={page}>
      <div className="settings-page-heading">
        <div>
          <h1>{sectionCopy[section].title}</h1>
          <p className="page-description">{sectionCopy[section].description}</p>
        </div>
        {savesSettings && (
          <button
            className="button primary"
            onClick={() => void save()}
            disabled={saving || !hasChanges}
          >
            {saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}{' '}
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        )}
      </div>
      {!savesSettings && hasChanges && (
        <p className="settings-unsaved" role="status">
          You have unsaved changes in other settings.
        </p>
      )}
      {section === 'conversations' && (
        <>
          <section className="settings-card">
            <div className="card-title">
              <span className="card-icon green">
                <MessageSquare size={20} />
              </span>
              <div>
                <h2>WhatsApp server</h2>
                <p>
                  {desktop
                    ? 'Choose where your WhatsApp connection runs.'
                    : 'Your WhatsApp session, connected to your own server.'}
                </p>
              </div>
              <span className="label">No chat replies</span>
            </div>
            {desktop ? (
              <>
                <div className="gateway-options">
                  {(
                    [
                      ['local', 'This computer', 'Wawa runs its own WhatsApp server here.'],
                      [
                        'remote',
                        'Another server',
                        'Use an existing OpenWA server, such as Legion.',
                      ],
                    ] as const
                  ).map(([mode, label, description]) => (
                    <label
                      className={`gateway-option ${draft.desktopGateway.mode === mode ? 'selected' : ''}`}
                      key={mode}
                    >
                      <input
                        type="radio"
                        name="gateway-mode"
                        value={mode}
                        checked={draft.desktopGateway.mode === mode}
                        onChange={() =>
                          setDraft({ ...draft, desktopGateway: { ...draft.desktopGateway, mode } })
                        }
                      />
                      <span>
                        <strong>{label}</strong>
                        <small>{description}</small>
                      </span>
                    </label>
                  ))}
                </div>
                {draft.desktopGateway.mode === 'local' && (
                  <div className="gateway-options" aria-label="WhatsApp connection type">
                    {(
                      [
                        ['whatsapp-web.js', 'Standard', 'Uses a browser in the background.'],
                        [
                          'baileys',
                          'Lightweight · experimental',
                          'No browser; tested offline only. Account restriction risk may be higher.',
                        ],
                      ] as const
                    ).map(([engine, label, description]) => (
                      <label
                        className={`gateway-option ${draft.desktopGateway.engine === engine ? 'selected' : ''}`}
                        key={engine}
                      >
                        <input
                          type="radio"
                          name="gateway-engine"
                          checked={draft.desktopGateway.engine === engine}
                          onChange={() =>
                            setDraft({
                              ...draft,
                              desktopGateway: { ...draft.desktopGateway, engine },
                            })
                          }
                        />
                        <span>
                          <strong>{label}</strong>
                          <small>{description}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                {draft.desktopGateway.mode === 'remote' && (
                  <div className="form-grid gateway-details">
                    <div className="field">
                      <label htmlFor="remote-openwa-url">Server address</label>
                      <input
                        id="remote-openwa-url"
                        placeholder="https://your-server.example"
                        value={draft.desktopGateway.remoteUrl}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            desktopGateway: { ...draft.desktopGateway, remoteUrl: e.target.value },
                          })
                        }
                      />
                      <small>Use the OpenWA address reachable from this computer.</small>
                    </div>
                    {credential('remote-openwa', 'Server API key')}
                  </div>
                )}
                <p className="gateway-note">
                  Your tasks stay here. Each connection keeps its own WhatsApp session and followed
                  chats; switching does not move or sign out a session. Unofficial connections can
                  lead to account restrictions.
                </p>
                {draft.desktopGateway.mode === 'remote' && (
                  <p className="gateway-note">
                    This workspace still pauses when this computer sleeps. To keep processing,
                    switch to an always-on workspace under Workspaces.
                  </p>
                )}
                {gatewayPending && (
                  <p className="gateway-restart" role="status">
                    {config.desktopGatewayRestartRequired && !hasChanges
                      ? 'Restart Wawa to use the saved connection.'
                      : 'Save your changes, then restart Wawa to use this connection.'}
                    {config.desktopGatewayRestartRequired &&
                      !hasChanges &&
                      window.chat2tasksDesktop && (
                        <button
                          className="text-button"
                          onClick={() => void window.chat2tasksDesktop?.restart()}
                        >
                          Restart Wawa
                        </button>
                      )}
                  </p>
                )}
              </>
            ) : (
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="openwa-url">OpenWA API URL</label>
                  <input
                    id="openwa-url"
                    placeholder="http://openwa-api:2785"
                    value={draft.openwaUrl}
                    onChange={(e) => setDraft({ ...draft, openwaUrl: e.target.value })}
                  />
                  <small>
                    {window.chat2tasksDesktop || window.chat2tasksTauri
                      ? 'This local address is managed by Wawa.'
                      : 'Use the address reachable from this Docker container.'}
                  </small>
                </div>
                {credential('openwa', 'OpenWA API key')}
              </div>
            )}
            {desktop &&
              !gatewayPending &&
              whatsapp &&
              ['failed', 'disconnected', 'action_required'].includes(whatsapp.status) && (
                <p className="gateway-note" role="status">
                  WhatsApp is not connected. Try linking it again.
                </p>
              )}
            {desktop && !gatewayPending && whatsapp?.qr && (
              <div className="onboarding-qr">
                <img src={whatsapp.qr} alt="WhatsApp pairing QR code" />
                <p>
                  On your phone, open WhatsApp → Linked devices → Link a device, then scan this
                  code.
                </p>
              </div>
            )}
            <div className="card-footer">
              <span>
                <ShieldCheck size={13} />{' '}
                {desktop ? 'Keys stay on this computer.' : 'Keys stay on your server.'}
              </span>
              {desktop &&
                !gatewayPending &&
                config.settings.desktopGateway.activeMode === 'local' &&
                whatsapp?.status !== 'ready' && (
                  <button
                    className="button secondary"
                    disabled={linkingWhatsapp}
                    onClick={() => {
                      setLinkingWhatsapp(true);
                      void api('desktop/whatsapp/start', z.object({ status: z.string() }), {})
                        .then(() => api('desktop/whatsapp/status', WhatsappStatus))
                        .then(setWhatsapp)
                        .catch((error) => {
                          setLinkingWhatsapp(false);
                          notify(errorMessage(error));
                        });
                    }}
                  >
                    {linkingWhatsapp ? 'Preparing connection…' : 'Link WhatsApp'}
                  </button>
                )}
              <button
                className="button secondary"
                disabled={Boolean(discovering) || !draft.openwaUrl || gatewayPending}
                onClick={() => void discover()}
              >
                {discovering === 'sessions' ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <RefreshCw size={14} />
                )}{' '}
                {discovering === 'sessions' ? 'Finding sessions…' : 'Find sessions'}
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
                  Followed conversations <span className="label">{activeCount} active</span>
                </h2>
                <p>
                  {gatewayPending
                    ? 'These are the chats for your currently connected server.'
                    : 'Only active chats are sent to your selected AI connection.'}
                </p>
              </div>
              <button
                className="button secondary"
                disabled={gatewayPending}
                onClick={() => setAddingChat(true)}
              >
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
                  disabled={!sessionId || Boolean(discovering)}
                  onClick={() => void discover(sessionId)}
                >
                  {discovering === 'chats' ? 'Finding chats…' : 'Find chats'}{' '}
                  <ChevronRight size={14} />
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
                      <p aria-live="polite">
                        {pendingChat?.id === c.id
                          ? pendingChat.action === 'pausing'
                            ? 'Pausing…'
                            : 'Resuming…'
                          : c.enabled
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
                      aria-busy={pendingChat?.id === c.id}
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
          {!desktop && (
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
                      notify(errorMessage(e), 'error');
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  <Radio size={14} /> Connect & test webhooks
                </button>
              </div>
            </section>
          )}
          <div className="privacy-strip">
            <ShieldCheck size={18} />
            <p>
              Pausing a chat stops new AI processing. Existing tasks, ticks, notes, and cached
              messages stay available. Wawa never sends a reply to WhatsApp.
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
            canDiscover={Boolean(draft.openwaUrl) && !gatewayPending}
            onDiscoverSessions={() => discover()}
            onDiscoverChats={() => discover(sessionId)}
            existingChats={draft.chats}
            onAdd={async (chat) => {
              const next = { ...draft, chats: [...draft.chats, chat] };
              if (await save(next)) setAddingChat(false);
            }}
          />
        </>
      )}
      {section === 'models' && (
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
                      draft.trigger.decisionProfileId === profile.id
                        ? { ...draft.trigger, decisionProfileId: null }
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
                if (result.error) notify(result.error, 'error');
                return result.models;
              }}
              notify={notify}
            />
          ))}
        </>
      )}
      {section === 'automation' && (
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
                        ? {
                            mode: 'manual',
                            decisionProfileId: draft.trigger.decisionProfileId ?? null,
                          }
                        : {
                            mode: 'automatic',
                            decisionProfileId: draft.trigger.decisionProfileId ?? null,
                          },
                  })
                }
              >
                <option value="automatic">Automatically · debounce, then decide</option>
                <option value="manual">Only when I choose Run now</option>
              </select>
            </div>
            <div className="field full-width">
              <label htmlFor="decision-connection">Decision connection</label>
              <select
                id="decision-connection"
                value={draft.trigger.decisionProfileId ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    trigger: { ...draft.trigger, decisionProfileId: e.target.value || null },
                  })
                }
              >
                <option value="">Use the task model for reviews</option>
                {draft.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.model}
                  </option>
                ))}
              </select>
              <small>
                OpenAI Decisions, Jev, Codex, or another configured connection. This connection
                reviews item categories and proposed completions. In automatic mode it also decides
                when to run. Uncertain results keep work visible or ask for confirmation.
              </small>
            </div>
            <div className="field">
              <label>Message delivery</label>
              <div className="codex-hint">
                <Radio size={16} />
                <p>
                  {desktop
                    ? 'New messages trigger work as they arrive.'
                    : 'OpenWA webhooks trigger work as messages arrive; no periodic message polling.'}
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
      )}
      {section === 'models' && (
        <>
          <div className="privacy-strip">
            <ShieldCheck size={18} />
            <p>
              {window.chat2tasksDesktop || window.chat2tasksTauri
                ? 'API keys are encrypted on this computer and are not shown after saving. Conversations go only to your selected model connection. Use Workspaces to create an encrypted backup.'
                : 'API keys are encrypted on your server and never sent back to this browser. Conversations go only to your selected model connection. Keep the data volume and its vault key backed up together.'}
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
      <div hidden={section !== 'browser'}>
        <CompanionSettings notify={notify} />
      </div>
      <div hidden={section !== 'attention'}>
        <AttentionSettings notify={notify} />
        <section className="settings-card">
          <div className="card-title">
            <span className="card-icon">
              <Volume2 size={20} />
            </span>
            <div>
              <h2>Sounds</h2>
              <p>Choose sounds for this workspace and its paired browser companion.</p>
            </div>
          </div>
          <SoundPreferencesEditor value={sound} onSave={onSoundSave} />
        </section>
      </div>
      <div hidden={section !== 'workspace'}>
        {window.chat2tasksTauri && (
          <section className="settings-card">
            <div className="card-title">
              <span className="card-icon green">
                <Server size={20} />
              </span>
              <div>
                <h2>Where work happens</h2>
                <p>
                  This workspace runs on this computer. Connect to an always-on server to keep
                  processing while it sleeps.
                </p>
              </div>
            </div>
            <button
              className="button secondary"
              onClick={() =>
                void openWorkspacePicker().catch((error) => notify(errorMessage(error), 'error'))
              }
            >
              Switch workspace
            </button>
          </section>
        )}
        {window.chat2tasksTauri && !window.chat2tasksTauri.demo && (
          <DesktopSharingSettings notify={notify} />
        )}
        <WorkspaceTransfer notify={notify} onImport={onImportWorkspace} />
      </div>
      {savesSettings && (
        <div className="settings-save-bottom">
          <button
            className="button primary"
            disabled={saving || !hasChanges}
            onClick={() => void save()}
          >
            <Check size={14} />
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <span>{hasChanges ? 'You have unsaved changes.' : 'All changes saved.'}</span>
        </div>
      )}
    </div>
  );
}
