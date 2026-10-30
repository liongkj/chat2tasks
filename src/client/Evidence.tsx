import { useEffect, useState } from 'react';
import { FileText, Link2, TriangleAlert } from 'lucide-react';
import type { Message } from '../shared/schema.js';
import { appFetch, time } from './api.js';
import { clockTime } from './conversations.js';

export function MessageCard({
  message,
  name,
  allMessages,
  highlighted = false,
  focused = false,
  continuation = false,
  compact = false,
}: {
  message: Message;
  name: string;
  allMessages: Message[];
  highlighted?: boolean;
  focused?: boolean;
  continuation?: boolean;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [loadedImageId, setLoadedImageId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const mediaPath = `/api/media?id=${encodeURIComponent(message.id)}`;
  useEffect(() => {
    if (!window.chat2tasksTauri || message.type !== 'image') return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setFailed(false);
    void appFetch(mediaPath, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Image unavailable');
        return response.blob();
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setPreview({ id: message.id, url: objectUrl });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [mediaPath, message.id, message.type]);
  const imageUrl = window.chat2tasksTauri
    ? preview?.id === message.id
      ? preview.url
      : null
    : mediaPath;
  const author = message.direction === 'outgoing' ? 'You' : `From ${name}`;
  return (
    <article
      className={`message-card ${message.direction} ${highlighted || focused ? 'linked-evidence' : ''} ${continuation ? 'continuation' : ''} ${compact ? 'compact' : ''}`}
      id={`message-${message.id}`}
      data-message-id={message.id}
    >
      {!continuation && (
        <div className="message-heading">
          <span className="tiny-avatar" aria-hidden="true">
            {message.direction === 'outgoing' ? 'Y' : name.slice(0, 1)}
          </span>
          <strong>{author}</strong>
          {compact && (
            <time
              dateTime={
                message.timestamp ? new Date(message.timestamp * 1000).toISOString() : undefined
              }
            >
              {message.timestamp ? time(message.timestamp) : 'Time unavailable'}
            </time>
          )}
          {(highlighted || focused) && (
            <span className="evidence-indicator">
              <Link2 size={12} /> {highlighted ? 'Task evidence' : 'Original message'}
            </span>
          )}
        </div>
      )}
      <div className="message-content">
        {message.reply_to_wa_id && (
          <blockquote>
            {message.reply_quote ||
              allMessages.find((item) => item.id === message.reply_to_id)?.body ||
              'Quoted attachment'}
          </blockquote>
        )}
        {message.body && <p>{message.body}</p>}
        {!message.body && message.type !== 'image' && (
          <p className="attachment-label">
            <FileText size={16} />{' '}
            {message.type === 'text' ? 'Message without text' : `${message.type} attachment`}
          </p>
        )}
        {message.browser_source && (
          <p className="browser-source-label">
            Captured selection · {message.browser_source.title} · WhatsApp Web
          </p>
        )}
        {message.type === 'image' && (
          <div className="image-preview">
            {failed ? (
              <div className="image-unavailable" role="status">
                <TriangleAlert size={16} />
                <span>The original image is unavailable from OpenWA.</span>
              </div>
            ) : (
              <>
                {loadedImageId !== message.id && (
                  <p className="attachment-label" role="status">
                    Loading image…
                  </p>
                )}
                {imageUrl && (
                  <a href={imageUrl} target="_blank" rel="noreferrer">
                    <img
                      src={imageUrl}
                      alt={`Attachment in ${name}, ${time(message.timestamp)}`}
                      loading="lazy"
                      onLoad={() => setLoadedImageId(message.id)}
                      onError={() => setFailed(true)}
                    />
                  </a>
                )}
              </>
            )}
          </div>
        )}
        {!compact && (
          <time
            dateTime={
              message.timestamp ? new Date(message.timestamp * 1000).toISOString() : undefined
            }
            title={time(message.timestamp)}
          >
            {message.timestamp ? clockTime(message.timestamp) : 'Time unavailable'}
          </time>
        )}
      </div>
      {message.image_reading && (
        <details className="image-reading">
          <summary>What AI could read</summary>
          {message.image_reading.observations.map((text, i) => (
            <p key={i}>{text}</p>
          ))}
          {message.image_reading.uncertainties.map((text, i) => (
            <p className="uncertainty" key={i}>
              {text}
            </p>
          ))}
        </details>
      )}
    </article>
  );
}
