import { Dialog } from '@base-ui/react/dialog';
import { ChevronRight, Radio, Server, Sparkles, X, Zap, Cloud } from 'lucide-react';
import { type Profile } from '../../shared/schema.js';

export function ModelDialog({
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
