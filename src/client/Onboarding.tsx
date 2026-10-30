import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleHelp,
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
  const [ready, setReady] = useState<boolean | null>(window.chat2tasksDesktop ? null : true);
  useEffect(() => {
    if (!window.chat2tasksDesktop) return;
    void api('desktop/status', DesktopStatus)
      .then((state) => setReady(state.setupComplete))
      .catch(() => setReady(false));
  }, []);
  if (ready === null) return <main className="onboarding-loading">Starting your workspace…</main>;
  return ready ? children : <Onboarding onDone={() => setReady(true)} />;
}

function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<z.infer<typeof DesktopStatus> | null>(null);
  const [whatsapp, setWhatsapp] = useState<z.infer<typeof WhatsappStatus>>({
    status: 'not_connected',
    qr: null,
  });
  const [chats, setChats] = useState<z.infer<typeof Chats>['chats']>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [preferences, setPreferences] = useState<AttentionPreferences>(() =>
    AttentionPreferencesSchema.parse({}),
  );
  const [accepted, setAccepted] = useState(false);
  const [oldPaused, setOldPaused] = useState(false);
  const [fileSelected, setFileSelected] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tested, setTested] = useState(false);
  async function refreshStatus() {
    setStatus(await api('desktop/status', DesktopStatus));
  }
  useEffect(() => {
    void refreshStatus().catch(() => undefined);
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
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [step]);
  useEffect(() => {
    if (step !== 2) return;
    void api('desktop/chats', Chats)
      .then((result) => setChats(result.chats))
      .catch((reason) => setError(message(reason)));
  }, [step]);
  useEffect(() => {
    if (step !== 3) return;
    const timer = setInterval(() => void refreshStatus().catch(() => undefined), 2500);
    return () => clearInterval(timer);
  }, [step]);
  async function run(action: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
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
    await run(async () => {
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
    (step === 2 && selected.length > 0) ||
    (step === 3 && status?.codex.signedIn) ||
    step === 4 ||
    (step === 5 && (!status?.imported || oldPaused));
  return (
    <main className="onboarding-shell">
      <aside className="onboarding-sidebar">
        <div className="onboarding-brand">
          <span>
            <Check size={17} />
          </span>{' '}
          chat2tasks
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
          <ShieldCheck size={17} /> Your workspace stays on this Mac. Selected evidence is sent to
          your chosen AI provider.
        </div>
      </aside>
      <div className="onboarding-main">
        <div className="onboarding-top">
          <span>SET UP CHAT2TASKS</span>
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
              <h1>Welcome to Chat2Tasks.</h1>
              <p className="onboarding-lede">
                Turn the things that need your attention into a calmer place to work.
              </p>
              <div className="onboarding-explainer">
                <strong>Start fresh or bring your work along.</strong>
                <p>
                  We’ll connect WhatsApp, sign in to Codex, and learn what matters to you. Your Mac
                  needs to be awake while it processes messages.
                </p>
              </div>
              <div className="onboarding-import">
                <h2>Already have a workspace?</h2>
                <p>
                  In your existing workspace, open Settings → Move your workspace and download an
                  encrypted transfer.
                </p>
                <button
                  className="button secondary"
                  onClick={() =>
                    void run(async () => {
                      setFileSelected((await window.chat2tasksDesktop?.chooseImport()) ?? false);
                    })
                  }
                >
                  Choose transfer file
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
                      onClick={() => void run(importFile)}
                    >
                      Import workspace
                    </button>
                  </div>
                )}
              </div>
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
                    disabled={!accepted || busy}
                    onClick={() =>
                      void run(async () => {
                        await api('desktop/whatsapp/start', z.object({ status: z.string() }), {});
                        setWhatsapp(await api('desktop/whatsapp/status', WhatsappStatus));
                      })
                    }
                  >
                    {busy ? 'Starting…' : 'Connect WhatsApp'}
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
                  {whatsapp.status !== 'not_connected' && !whatsapp.qr && (
                    <p className="onboarding-hint">
                      Connection: {whatsapp.status.replaceAll('_', ' ')}
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
                Choose the conversations Chat2Tasks should process. You can change this later.
              </p>
              <p className="onboarding-hint">
                Available history in selected chats can be processed after setup. Conversation text
                and relevant screenshots go to the selected AI provider.
              </p>
              <div className="onboarding-chat-list">
                {chats.length ? (
                  chats.map((chat) => (
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
                Chat2Tasks uses the Codex CLI on this Mac. Sign in with your ChatGPT account to
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
                    void run(async () => {
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
                  {status?.codex.signingIn
                    ? 'Continue sign-in in your browser'
                    : 'Continue with ChatGPT'}
                </button>
              )}
              {status && !status.codex.installed && (
                <p className="onboarding-hint">
                  The bundled Codex CLI could not be found. Reinstall Chat2Tasks or contact support.
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
                      void run(async () => {
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
                    {tested ? 'Connection works' : 'Test connection'}
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
            {step === 5 ? 'Open my workspace' : 'Continue'} <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </main>
  );
}
