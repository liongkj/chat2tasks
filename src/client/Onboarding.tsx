import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleHelp,
  LoaderCircle,
  MessageCircle,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { z } from 'zod';
import {
  AttentionPreferencesSchema,
  PublicSettingsSchema,
  type AttentionPreferences,
} from '../shared/schema.js';
import { api, OkSchema } from './api.js';
import { AttentionPreferencesEditor } from './AttentionPreferences.js';
import { openWorkspacePicker } from './tauri.js';
import './onboarding.css';

const DesktopStatus = z.object({
  setupComplete: z.boolean(),
  imported: z.boolean(),
  codex: z.object({
    installed: z.boolean(),
    signedIn: z.boolean(),
    signingIn: z.boolean(),
    failed: z.boolean(),
  }),
});
const WhatsappStatus = z.object({ status: z.string(), qr: z.string().nullable() });
const Chats = z.object({ chats: z.array(z.object({ id: z.string(), name: z.string() })) });
const steps = ['Welcome', 'WhatsApp', 'Conversations', 'Codex', 'Preferences', 'Ready'];

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export function DesktopRoot({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState<'loading' | 'ready' | 'setup' | 'error'>(
    window.chat2tasksDesktop ? 'loading' : 'ready',
  );
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!window.chat2tasksDesktop) return;
    setReady('loading');
    void api('desktop/status', DesktopStatus)
      .then((state) => setReady(state.setupComplete ? 'ready' : 'setup'))
      .catch(() => setReady('error'));
  }, [retry]);
  if (ready === 'loading')
    return (
      <main className="onboarding-loading" role="status">
        <LoaderCircle className="spin" size={20} /> Opening your workspace…
      </main>
    );
  if (ready === 'error')
    return (
      <main className="onboarding-loading" role="alert">
        Couldn’t open your workspace.{' '}
        <button className="text-button" onClick={() => setRetry((value) => value + 1)}>
          Try again
        </button>
      </main>
    );
  return ready === 'ready' ? children : <Onboarding onDone={() => setReady('ready')} />;
}

function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(() =>
    localStorage.getItem('wawa-onboarding-resume') === 'whatsapp' ? 1 : 0,
  );
  const [engine, setEngine] = useState<'whatsapp-web.js' | 'baileys'>('whatsapp-web.js');
  const [activeEngine, setActiveEngine] = useState<'whatsapp-web.js' | 'baileys' | null>(null);
  const [engineError, setEngineError] = useState(false);
  const [status, setStatus] = useState<z.infer<typeof DesktopStatus> | null>(null);
  const [whatsapp, setWhatsapp] = useState<z.infer<typeof WhatsappStatus>>({
    status: 'not_connected',
    qr: null,
  });
  const [chats, setChats] = useState<z.infer<typeof Chats>['chats']>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [chatRefresh, setChatRefresh] = useState(0);
  const [chatQuery, setChatQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [preferences, setPreferences] = useState<AttentionPreferences>(() =>
    AttentionPreferencesSchema.parse({}),
  );
  const [accepted, setAccepted] = useState(false);
  const [oldPaused, setOldPaused] = useState(false);
  const [fileSelected, setFileSelected] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [operation, setOperation] = useState<
    'choosing' | 'importing' | 'whatsapp' | 'codex' | 'test' | 'continue' | null
  >(null);
  const busy = operation !== null;
  const [error, setError] = useState('');
  const [tested, setTested] = useState(false);
  async function refreshStatus() {
    setStatus(await api('desktop/status', DesktopStatus));
  }
  async function loadEngine() {
    setEngineError(false);
    try {
      const { settings } = await api('settings', PublicSettingsSchema);
      setEngine(settings.desktopGateway.engine);
      setActiveEngine(settings.desktopGateway.activeEngine);
    } catch {
      setEngineError(true);
    }
  }
  useEffect(() => {
    localStorage.removeItem('wawa-onboarding-resume');
    void refreshStatus().catch(() => undefined);
    void loadEngine();
    void api('preferences', AttentionPreferencesSchema)
      .then(setPreferences)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (step !== 1) return;
    const refresh = () =>
      void api('desktop/whatsapp/status', WhatsappStatus)
        .then(setWhatsapp)
        .catch(() => undefined);
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [step]);
  useEffect(() => {
    if (step !== 2) return;
    let cancelled = false;
    setChatsLoaded(false);
    setError('');
    void api('desktop/chats', Chats)
      .then((result) => {
        if (!cancelled) setChats(result.chats);
      })
      .catch((reason) => {
        if (!cancelled) setError(message(reason));
      })
      .finally(() => {
        if (!cancelled) setChatsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [step, chatRefresh]);
  useEffect(() => {
    if (step !== 3) return;
    const timer = setInterval(() => void refreshStatus().catch(() => undefined), 2500);
    return () => clearInterval(timer);
  }, [step]);
  async function run(name: NonNullable<typeof operation>, action: () => Promise<void>) {
    setError('');
    setOperation(name);
    try {
      await action();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setOperation(null);
    }
  }
  async function importFile() {
    const desktop = window.chat2tasksDesktop;
    if (!desktop) return;
    const result = await desktop.importWorkspace(passphrase);
    if (!result.ok) throw new Error(result.error ?? 'Could not open that transfer file.');
    setPassphrase('');
    window.location.reload();
  }
  async function next() {
    await run('continue', async () => {
      if (step === 2) await api('desktop/chats', OkSchema, { ids: selected });
      if (step === 4) await api('preferences', AttentionPreferencesSchema, preferences);
      if (step === 5) {
        await api('desktop/finish', OkSchema, {});
        onDone();
        return;
      }
      setStep((current) => Math.min(current + 1, steps.length - 1));
    });
  }
  const canContinue =
    step === 0 ||
    (step === 1 && whatsapp.status === 'ready') ||
    (step === 2 && chatsLoaded && !error && selected.length > 0) ||
    (step === 3 && status?.codex.signedIn) ||
    step === 4 ||
    (step === 5 && (!status?.imported || oldPaused));
  const matchingChats = chats.filter((chat) =>
    chat.name.toLocaleLowerCase().includes(chatQuery.trim().toLocaleLowerCase()),
  );
  return (
    <main className="onboarding-shell">
      <aside className="onboarding-sidebar">
        <div className="onboarding-brand">
          <span>
            <Check size={17} />
          </span>{' '}
          wawa
        </div>
        <p className="onboarding-eyebrow">YOUR WORKSPACE</p>
        <nav aria-label="Setup progress">
          {steps.map((name, index) => (
            <div
              key={name}
              className={`onboarding-step ${index === step ? 'current' : ''} ${index < step ? 'complete' : ''}`}
            >
              <span>{index < step ? <Check size={14} /> : index + 1}</span>
              {name}
            </div>
          ))}
        </nav>
        <div className="onboarding-sidebar-note">
          <ShieldCheck size={17} /> Your workspace stays on this computer. Selected evidence is sent
          to your chosen AI provider.
        </div>
      </aside>
      <div className="onboarding-main">
        <div className="onboarding-top">
          <span>SET UP WAWA</span>
          <span>
            {step + 1} / {steps.length}
          </span>
        </div>
        <div className="onboarding-content">
          {step === 0 && (
            <>
              <div className="onboarding-icon">
                <Sparkles size={23} />
              </div>
              <p className="onboarding-kicker">A LITTLE MORE SPACE TO THINK</p>
              <h1>Welcome to Wawa.</h1>
              <p className="onboarding-lede">
                Turn the things that need your attention into a calmer place to work.
              </p>
              <div className="onboarding-explainer">
                <strong>Start fresh or bring your work along.</strong>
                <p>
                  We’ll connect WhatsApp, sign in to Codex, and learn what matters to you. Your
                  computer needs to be awake while it processes messages.
                </p>
              </div>
              {window.chat2tasksTauri && (
                <div className="onboarding-import">
                  <h2>Already have an always-on workspace?</h2>
                  <p>Connect to it here. It can keep working while this computer sleeps.</p>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void openWorkspacePicker().catch((reason) => setError(message(reason)))
                    }
                  >
                    Use another computer
                  </button>
                </div>
              )}
              {status?.imported ? (
                <div className="onboarding-connected" role="status">
                  <CheckCircle2 size={20} /> Workspace imported. Continue to reconnect your
                  accounts.
                </div>
              ) : (
                <div className="onboarding-import">
                  <h2>Already have a workspace?</h2>
                  <p>
                    In your existing workspace, open Settings → Workspaces and download an encrypted
                    transfer.
                  </p>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void run('choosing', async () => {
                        setFileSelected((await window.chat2tasksDesktop?.chooseImport()) ?? false);
                      })
                    }
                  >
                    {operation === 'choosing' ? 'Opening files…' : 'Choose transfer file'}
                  </button>
                  {fileSelected && (
                    <div className="onboarding-import-fields">
                      <label htmlFor="import-passphrase">Transfer passphrase</label>
                      <input
                        id="import-passphrase"
                        type="password"
                        value={passphrase}
                        onChange={(event) => setPassphrase(event.target.value)}
                      />
                      <button
                        className="button secondary"
                        disabled={busy || passphrase.length < 8}
                        onClick={() => void run('importing', importFile)}
                      >
                        {operation === 'importing' ? 'Importing…' : 'Import workspace'}
                      </button>
                      {operation === 'importing' && (
                        <p role="status">
                          Checking the file and restoring your workspace. This can take a moment.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {step === 1 && (
            <>
              <div className="onboarding-icon">
                <MessageCircle size={24} />
              </div>
              <p className="onboarding-kicker">CONNECT YOUR ACCOUNT</p>
              <h1>Bring your conversations in.</h1>
              <p className="onboarding-lede">
                Link WhatsApp as a device, then choose the conversations to follow.
              </p>
              <div className="onboarding-warning">
                <CircleHelp size={18} />
                <p>
                  This uses an unofficial WhatsApp connection. The gateway’s maintainers warn that
                  accounts can be restricted and advise against linking a primary number. The
                  gateway may store chat history separately from your selected chats.
                </p>
              </div>
              {whatsapp.status !== 'ready' && (
                <fieldset className="onboarding-engines">
                  <legend>Choose a connection</legend>
                  <label>
                    <input
                      type="radio"
                      name="whatsapp-engine"
                      checked={engine === 'whatsapp-web.js'}
                      onChange={() => setEngine('whatsapp-web.js')}
                    />
                    <span>
                      <strong>Standard</strong>
                      <small>Uses a browser in the background.</small>
                    </span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="whatsapp-engine"
                      checked={engine === 'baileys'}
                      onChange={() => setEngine('baileys')}
                    />
                    <span>
                      <strong>Lightweight · experimental</strong>
                      <small>
                        Uses no browser. Tested offline only; account restriction risk may be
                        higher.
                      </small>
                    </span>
                  </label>
                </fieldset>
              )}
              {activeEngine === null && (
                <p className="onboarding-hint" role="status">
                  {engineError ? (
                    <>
                      Couldn’t load connection choices.{' '}
                      <button className="text-button" onClick={() => void loadEngine()}>
                        Try again
                      </button>
                    </>
                  ) : (
                    'Loading connection choices…'
                  )}
                </p>
              )}
              {whatsapp.status === 'ready' ? (
                <div className="onboarding-connected">
                  <CheckCircle2 size={20} /> WhatsApp is connected
                </div>
              ) : (
                <>
                  <label className="onboarding-consent">
                    <input
                      type="checkbox"
                      checked={accepted}
                      onChange={(event) => setAccepted(event.target.checked)}
                    />{' '}
                    I understand and want to link an account.
                  </label>
                  <button
                    className="button primary"
                    disabled={!accepted || busy || activeEngine === null}
                    onClick={() =>
                      void run('whatsapp', async () => {
                        if (engine !== activeEngine) {
                          const current = await api('settings', PublicSettingsSchema);
                          await api('settings', PublicSettingsSchema, {
                            settings: {
                              ...current.settings,
                              desktopGateway: { ...current.settings.desktopGateway, engine },
                            },
                            secrets: {},
                            removeSecrets: [],
                          });
                          localStorage.setItem('wawa-onboarding-resume', 'whatsapp');
                          await window.chat2tasksDesktop?.restart();
                          return;
                        }
                        await api('desktop/whatsapp/start', z.object({ status: z.string() }), {});
                        setWhatsapp(await api('desktop/whatsapp/status', WhatsappStatus));
                      })
                    }
                  >
                    {operation === 'whatsapp'
                      ? 'Starting…'
                      : engine !== activeEngine
                        ? 'Continue with this connection'
                        : 'Connect WhatsApp'}
                  </button>
                  {whatsapp.qr && (
                    <div className="onboarding-qr">
                      <img src={whatsapp.qr} alt="WhatsApp pairing QR code" />
                      <p>
                        On your phone, open WhatsApp → Linked devices → Link a device, then scan
                        this code.
                      </p>
                    </div>
                  )}
                  {(operation === 'whatsapp' ||
                    (whatsapp.status !== 'not_connected' && !whatsapp.qr)) && (
                    <p className="onboarding-hint" role="status">
                      {['failed', 'disconnected', 'action_required'].includes(whatsapp.status)
                        ? 'WhatsApp is not connected. Try connecting again.'
                        : whatsapp.status === 'authenticating'
                          ? 'Finishing WhatsApp sign-in…'
                          : 'Preparing your WhatsApp connection. The QR code will appear here.'}
                    </p>
                  )}
                </>
              )}
            </>
          )}
          {step === 2 && (
            <>
              <div className="onboarding-icon">
                <MessageCircle size={24} />
              </div>
              <p className="onboarding-kicker">CHOOSE WHAT TO FOLLOW</p>
              <h1>Make it yours.</h1>
              <p className="onboarding-lede">
                Choose the conversations Wawa should process. You can change this later.
              </p>
              <p className="onboarding-hint">
                New messages and any history available to this connection can be processed after
                setup. Conversation text and relevant screenshots go to the selected AI provider.
              </p>
              {chatsLoaded && chats.length > 0 && (
                <div className="field onboarding-search">
                  <label htmlFor="onboarding-chat-search">Search conversations</label>
                  <input
                    id="onboarding-chat-search"
                    value={chatQuery}
                    onChange={(event) => setChatQuery(event.target.value)}
                    placeholder="Search by name"
                  />
                  <small>{selected.length} selected</small>
                </div>
              )}
              <div className="onboarding-chat-list">
                {!chatsLoaded ? (
                  <p className="onboarding-hint onboarding-wait" role="status">
                    <LoaderCircle className="spin" size={16} /> Loading your conversations…
                  </p>
                ) : error ? (
                  <button
                    className="button secondary"
                    onClick={() => setChatRefresh((value) => value + 1)}
                  >
                    Try again
                  </button>
                ) : matchingChats.length ? (
                  matchingChats.map((chat) => (
                    <label key={chat.id}>
                      <span>{chat.name}</span>
                      <input
                        type="checkbox"
                        checked={selected.includes(chat.id)}
                        onChange={(event) =>
                          setSelected((previous) =>
                            event.target.checked
                              ? [...previous, chat.id]
                              : previous.filter((id) => id !== chat.id),
                          )
                        }
                      />
                    </label>
                  ))
                ) : chats.length ? (
                  <p>No conversations match your search.</p>
                ) : (
                  <p>No conversations found yet. Make sure WhatsApp has finished syncing.</p>
                )}
              </div>
            </>
          )}
          {step === 3 && (
            <>
              <div className="onboarding-icon">
                <Sparkles size={23} />
              </div>
              <p className="onboarding-kicker">CONNECT YOUR AI</p>
              <h1>Sign in to Codex.</h1>
              <p className="onboarding-lede">
                Wawa uses the Codex CLI on this computer. Sign in with your ChatGPT account to
                connect it.
              </p>
              {status?.codex.signedIn ? (
                <div className="onboarding-connected">
                  <CheckCircle2 size={20} /> Signed in to Codex
                </div>
              ) : (
                <button
                  className="button primary"
                  disabled={busy || !status?.codex.installed}
                  onClick={() =>
                    void run('codex', async () => {
                      const result = await api(
                        'desktop/codex/login',
                        z.object({ url: z.url() }),
                        {},
                      );
                      await window.chat2tasksDesktop?.openExternal(result.url);
                      await refreshStatus();
                    })
                  }
                >
                  {operation === 'codex'
                    ? 'Opening sign-in…'
                    : status?.codex.signingIn
                      ? 'Continue sign-in in your browser'
                      : 'Continue with ChatGPT'}
                </button>
              )}
              {!status && (
                <p className="onboarding-hint" role="status">
                  Checking your Codex connection…
                </p>
              )}
              {status?.codex.signingIn && (
                <p className="onboarding-hint" role="status">
                  Finish signing in in your browser. This screen will update automatically.
                </p>
              )}
              {status?.codex.failed && (
                <p className="onboarding-error" role="alert">
                  Sign-in didn’t finish. Please try again.
                </p>
              )}
              {status && !status.codex.installed && (
                <p className="onboarding-hint">
                  The bundled Codex CLI could not be found. Reinstall Wawa or contact support.
                </p>
              )}
              {status?.codex.signedIn && (
                <div className="onboarding-explainer">
                  <strong>Check the connection</strong>
                  <p>
                    Sign-in does not guarantee the selected model is available. Test it using a
                    fictional example.
                  </p>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void run('test', async () => {
                        const config = await api('settings', PublicSettingsSchema);
                        const profile = config.settings.profiles.find(
                          (item) => item.kind === 'codex',
                        );
                        if (!profile) throw new Error('Codex is not configured.');
                        await api('test-model', OkSchema, { profileId: profile.id });
                        setTested(true);
                      })
                    }
                  >
                    {operation === 'test'
                      ? 'Testing connection…'
                      : tested
                        ? 'Connection works'
                        : 'Test connection'}
                  </button>
                </div>
              )}
            </>
          )}
          {step === 4 && (
            <>
              <div className="onboarding-icon">
                <Sparkles size={23} />
              </div>
              <p className="onboarding-kicker">WHAT DESERVES YOUR ATTENTION?</p>
              <h1>Set your preferences.</h1>
              <p className="onboarding-lede">
                Tasks are substantial work. A small request is an action; questions, reminders, and
                things you’re waiting for each have their own place.
              </p>
              <AttentionPreferencesEditor value={preferences} onChange={setPreferences} />
            </>
          )}
          {step === 5 && (
            <>
              <div className="onboarding-icon">
                <CheckCircle2 size={23} />
              </div>
              <p className="onboarding-kicker">READY WHEN YOU ARE</p>
              <h1>Everything in its place.</h1>
              <p className="onboarding-lede">
                Your selected conversations will start processing when you finish. You can pause
                them or change these choices later.
              </p>
              <div className="onboarding-summary">
                <span>
                  WhatsApp <strong>Connected</strong>
                </span>
                <span>
                  Conversations <strong>{selected.length} selected</strong>
                </span>
                <span>
                  Codex <strong>Signed in</strong>
                </span>
              </div>
              {status?.imported && (
                <label className="onboarding-consent">
                  <input
                    type="checkbox"
                    checked={oldPaused}
                    onChange={(event) => setOldPaused(event.target.checked)}
                  />{' '}
                  I’ve paused processing on the old workspace before starting this one.
                </label>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="onboarding-error">
              {error}
            </p>
          )}
        </div>
        <div className="onboarding-footer">
          {step > 0 ? (
            <button
              className="button ghost"
              disabled={busy}
              onClick={() => {
                setError('');
                setStep(step - 1);
              }}
            >
              <ArrowLeft size={16} /> Back
            </button>
          ) : (
            <span />
          )}
          <button
            className="button primary"
            disabled={busy || !canContinue}
            onClick={() => void next()}
          >
            {operation === 'continue'
              ? step === 2
                ? 'Saving conversations…'
                : step === 4
                  ? 'Saving preferences…'
                  : step === 5
                    ? 'Connecting your workspace…'
                    : 'Please wait…'
              : step === 5
                ? 'Open my workspace'
                : 'Continue'}{' '}
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </main>
  );
}
