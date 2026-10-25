import { MessageSchema } from '../shared/schema.js';
import { now } from './store.js';
import type { Threads } from './threads.js';

export function seedDemoThreads(threads: Threads) {
  const store = threads.store;
  if (store.metaValue('demo_threads')) return;
  const extra = [
    MessageSchema.parse({
      id: 'sample-thread-followup',
      sessionId: 'sample',
      chatId: 'product-sample',
      waMessageId: 'sample-thread-followup',
      body: 'For the onboarding review: we can remove company size from the first screen.',
      type: 'text',
      direction: 'incoming',
      timestamp: now() - 300,
    }),
    MessageSchema.parse({
      id: 'sample-thread-lunch',
      sessionId: 'sample',
      chatId: 'alex-sample',
      waMessageId: 'sample-thread-lunch',
      body: 'Lunch on Thursday works for me.',
      type: 'text',
      direction: 'incoming',
      timestamp: now() - 200,
    }),
  ];
  store.cache(extra);
  const messages = threads.snapshot().messages;
  threads.apply(
    {
      threads: [
        {
          id: null,
          title: 'Onboarding review',
          messageIds: ['sample-message-0', 'sample-thread-followup'],
        },
        { id: null, title: 'Thursday lunch', messageIds: ['sample-thread-lunch'] },
        ...messages
          .filter((m) => m.id !== 'sample-message-0' && !extra.some((x) => x.id === m.id))
          .map((m) => ({
            id: null,
            title:
              store.snapshot().tasks.find((t) => t.source_ids.includes(m.id))?.title ??
              'Conversation',
            messageIds: [m.id],
          })),
      ],
      otherMessageIds: [],
    },
    messages,
  );
  store.setMeta('demo_threads', true);
}
