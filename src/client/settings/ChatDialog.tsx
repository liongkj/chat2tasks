import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { LoaderCircle, MessageSquare, Plus, RefreshCw, X } from 'lucide-react';
import { type Chat } from '../../shared/schema.js';

export type DiscoveredEntry = { id: string; name: string };

export function ChatDialog({
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
  discovering: 'sessions' | 'chats' | null;
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
                        disabled={Boolean(discovering) || !canDiscover}
                      >
                        {discovering === 'sessions' ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : (
                          <RefreshCw size={14} />
                        )}
                        {discovering === 'sessions' ? 'Finding sessions…' : 'Find sessions'}
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
                        disabled={!sessionId || Boolean(discovering) || !canDiscover}
                      >
                        {discovering === 'chats' ? (
                          <LoaderCircle size={14} className="spin" />
                        ) : (
                          <RefreshCw size={14} />
                        )}
                        {discovering === 'chats' ? 'Finding chats…' : 'Find chats'}
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
