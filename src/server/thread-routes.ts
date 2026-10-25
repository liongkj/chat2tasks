import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AnnotationRequestSchema, ThreadMoveSchema } from '../shared/threads.js';
import { Threads, ThreadError } from './threads.js';
import type { Threading } from './threading.js';
import type { OpenWA } from './openwa.js';

export function registerThreadRoutes(
  server: FastifyInstance,
  prefix: string,
  threads: Threads,
  organiser: Threading,
  openwa: OpenWA,
) {
  server.get(prefix + '/threads', () => ({
    ...threads.snapshot(),
    canOrganise: organiser.enabled,
  }));
  server.post(prefix + '/threads/enable', () => {
    if (!organiser.enabled)
      throw new ThreadError(409, 'Thread organisation is disabled in this workspace.');
    organiser.enable();
    return { ok: true };
  });
  server.post(prefix + '/threads/organise', () => {
    if (!organiser.enabled)
      throw new ThreadError(409, 'Thread organisation is disabled in this workspace.');
    organiser.request();
    return { ok: true };
  });
  server.post(prefix + '/threads/move', (request) =>
    threads.move(ThreadMoveSchema.parse(request.body)),
  );
  server.post(prefix + '/annotations', (request) =>
    threads.annotations(AnnotationRequestSchema.parse(request.body).waIds),
  );
  server.get(prefix + '/threads/media/:id', async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const message = threads.snapshot().messages.find((m) => m.id === id);
    if (!message) throw new ThreadError(404, 'Original message not found.');
    const image = await openwa.media(message);
    if (!image) throw new ThreadError(404, 'The original image is unavailable.');
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(image.mime))
      throw new ThreadError(415, 'This image format is not supported.');
    return { dataUrl: `data:${image.mime};base64,${image.bytes.toString('base64')}` };
  });
}
