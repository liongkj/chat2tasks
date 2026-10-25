import { useState } from 'react';
import { FileText, Link2, TriangleAlert } from 'lucide-react';
import type { Message } from '../shared/schema.js';
import { time } from './api.js';
import { clockTime } from './conversations.js';

export function MessageCard({
  message,
  name,
  allMessages,
  highlighted = false,
  continuation = false,
  compact = false,
}: {
  message: Message;
  name: string;
  allMessages: Message[];
  highlighted?: boolean;
  continuation?: boolean;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const author = message.direction === 'outgoing' ? 'You' : `From ${name}`;
  return (
    <article
      className={`message-card ${message.direction} ${highlighted ? 'linked-evidence' : ''} ${continuation ? 'continuation' : ''} ${compact ? 'compact' : ''}`}
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
          {highlighted && (
            <span className="evidence-indicator">
              <Link2 size={12} /> Task evidence
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
        {message.type === 'image' &&
          (failed ? (
            <div className="image-unavailable">
              <TriangleAlert size={16} />
              <span>The original image is unavailable from OpenWA.</span>
            </div>
          ) : (
            <a
              href={`/api/media?id=${encodeURIComponent(message.id)}`}
              target="_blank"
              rel="noreferrer"
            >
              <img
                src={`/api/media?id=${encodeURIComponent(message.id)}`}
                alt={`Attachment in ${name}, ${time(message.timestamp)}`}
                loading="lazy"
                onError={() => setFailed(true)}
              />
            </a>
          ))}
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
