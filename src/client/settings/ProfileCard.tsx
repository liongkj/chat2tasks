import type { Notify } from '../../shared/useNotice.js';
import { useState } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
  Zap,
  Cloud,
} from 'lucide-react';
import { type Profile } from '../../shared/schema.js';
import { errorMessage } from '../../shared/errors.js';

export function ProfileCard({
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
  notify: Notify;
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
                Wawa <ChevronRight size={12} /> Cloudflare Gateway <ChevronRight size={12} />{' '}
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
            {window.chat2tasksDesktop || window.chat2tasksTauri ? (
              'Your Codex sign-in is stored on this computer. No API key is needed.'
            ) : (
              <>
                Sign in to Codex inside the container once. Your session lives in the private{' '}
                <code>codex-home</code> volume. No API key is needed.
              </>
            )}
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
                : 'https://github.com/liongkj/chat2tasks/blob/main/docs/technical-reference.md#model-connections'
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
                  notify(errorMessage(e), 'error');
                } finally {
                  setLoading(false);
                }
              }}
            >
              {loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}{' '}
              {loading ? 'Loading models…' : 'Load models'}
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
                notify(errorMessage(e), 'error');
              } finally {
                setTesting(false);
              }
            }}
          >
            {testing ? <LoaderCircle size={14} className="spin" /> : <Zap size={14} />}{' '}
            {testing ? 'Testing connection…' : 'Test connection'}
          </button>
        </div>
      </div>
    </section>
  );
}
