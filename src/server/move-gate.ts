import type { FastifyInstance } from 'fastify';

export class MoveGate {
  private paused = false;
  private running = 0;
  private waiters: Array<() => void> = [];

  constructor(server: FastifyInstance) {
    server.addHook('onRoute', (options) => {
      if (!options.url.startsWith('/api/') && options.url !== '/mcp') return;
      const handler = options.handler;
      const gate = this;
      options.handler = async function (request, reply) {
        if (gate.paused)
          return reply.code(503).send({ error: 'The workspace is moving. Try again shortly.' });
        gate.running++;
        try {
          return await handler.call(this, request, reply);
        } finally {
          gate.running--;
          if (gate.running === 0) {
            for (const resolve of gate.waiters.splice(0)) resolve();
          }
        }
      };
    });
  }

  pause() {
    this.paused = true;
    if (this.running === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  resume() {
    this.paused = false;
  }
}
