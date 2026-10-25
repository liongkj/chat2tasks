import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { registerMcp } from '../src/server/mcp.js';
import { Store } from '../src/server/store.js';
import { OpenWA } from '../src/server/openwa.js';
import { MessageSchema, TaskChangeSchema, TaskSchema } from '../src/shared/schema.js';

const token = 'test-mcp-token-that-is-at-least-32-characters';
const EvidenceSchema = z.object({
  task: TaskSchema,
  messages: z.array(MessageSchema),
  revision: z.string(),
});
const PageSchema = z.object({
  items: z.array(TaskSchema),
  total: z.number(),
  next_offset: z.number().nullable(),
});

async function fixture(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'chat2tasks-mcp-'));
  const store = new Store(dir);
  for (const done of [false, true]) {
    const message = MessageSchema.parse({
      id: done ? 'resolved-source' : 'open-source',
      sessionId: 'session',
      chatId: 'chat',
      body: done ? 'The settings fix is done' : 'The export is broken; waiting for a sample file',
      direction: 'incoming',
      timestamp: done ? 2 : 1,
    });
    store.cache([message]);
    store.apply(
      [
        TaskChangeSchema.parse({
          id: null,
          title: done ? 'Fix settings' : 'Restore the export',
          scope: 'Workspace',
          note: message.body,
          source_ids: [message.id],
          action_steps: ['Reproduce with the sample file'],
          done_when: ['The reported issue is resolved'],
          priority: done ? 'normal' : 'high',
          triage_state: done ? 'ready' : 'waiting',
          blocking_question: null,
        }),
      ],
      [message],
    );
  }
  const resolved = store.snapshot().tasks.find((task) => task.title === 'Fix settings');
  assert.ok(resolved);
  store.tick(resolved.id, true);
  store.saveSettings({
    settings: {
      ...store.settings(),
      chats: [
        {
          id: 'conversation',
          name: 'Project',
          sessionId: 'session',
          chatId: 'chat',
          enabled: true,
        },
      ],
    },
    secrets: { openwa: 'private-provider-key' },
    removeSecrets: [],
  });
  const server = Fastify();
  await registerMcp(server, store, {
    token: enabled ? token : undefined,
    origins: new Set(['https://tasks.example.com']),
  });
  const address = await server.listen({ port: 0, host: '127.0.0.1' });
  const url = new URL('/mcp', address);
  return {
    store,
    server,
    url,
    async close() {
      await server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('an MCP client reads evidence, images and conversations, then saves bounded triage with conflict protection', async () => {
  const f = await fixture();
  const client = new Client({ name: 'triage-test', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(f.url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const catalog = await client.listTools();
    assert.deepEqual(catalog.tools.map((tool) => tool.name).sort(), [
      'get_conversation',
      'get_source_image',
      'get_task',
      'list_conversations',
      'list_tasks',
      'triage_task',
    ]);
    assert.equal(
      catalog.tools.find((tool) => tool.name === 'triage_task')?.annotations?.readOnlyHint,
      false,
    );
    assert.ok((await client.getPrompt({ name: 'triage_issues' })).messages.length);
    const open = PageSchema.parse(
      (await client.callTool({ name: 'list_tasks', arguments: {} })).structuredContent,
    );
    assert.equal(open.total, f.store.snapshot().tasks.filter((task) => !task.done).length);
    assert.ok(open.items.some((task) => task.priority === 'high'));
    assert.ok(open.items.some((task) => task.triage_state !== 'ready'));
    const first = PageSchema.parse(
      (await client.callTool({ name: 'list_tasks', arguments: { status: 'all', limit: 1 } }))
        .structuredContent,
    );
    assert.equal(first.items.length, 1);
    assert.equal(first.next_offset, 1);
    const high = PageSchema.parse(
      (await client.callTool({ name: 'list_tasks', arguments: { priority: 'high' } }))
        .structuredContent,
    );
    assert.ok(high.items.length);
    assert.ok(high.items.every((task) => task.priority === 'high'));
    const task = open.items[0];
    assert.ok(task);
    const byReference = PageSchema.parse(
      (
        await client.callTool({
          name: 'list_tasks',
          arguments: { query: task.reference.toLowerCase() },
        })
      ).structuredContent,
    );
    assert.deepEqual(
      byReference.items.map((item) => item.id),
      [task.id],
    );
    f.store.remark(task.id, 'Owner note stays private to this field');
    const evidence = EvidenceSchema.parse(
      (await client.callTool({ name: 'get_task', arguments: { id: task.reference } }))
        .structuredContent,
    );
    assert.deepEqual(
      evidence.messages.map((message) => message.id).sort(),
      task.source_ids.toSorted(),
    );
    const chats = z
      .object({ items: z.array(z.object({ id: z.string(), name: z.string() })) })
      .parse(
        (await client.callTool({ name: 'list_conversations', arguments: {} })).structuredContent,
      );
    const chat = chats.items[0];
    assert.ok(chat);
    const conversation = await client.callTool({
      name: 'get_conversation',
      arguments: { id: chat.id, limit: 1 },
    });
    assert.equal(
      z.object({ items: z.array(MessageSchema) }).parse(conversation.structuredContent).items
        .length,
      1,
    );
    const image = MessageSchema.parse({
      ...evidence.messages[0],
      id: 'source-image',
      type: 'image',
      mediaMimetype: 'image/png',
    });
    f.store.cache([image]);
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH2kAAAAASUVORK5CYII=',
      'base64',
    );
    await new OpenWA(f.store).saveMedia(image.id, bytes);
    const sourceImage = await client.callTool({
      name: 'get_source_image',
      arguments: { message_id: image.id },
    });
    const block = z
      .object({
        content: z.array(
          z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
        ),
      })
      .parse(sourceImage).content[0];
    assert.ok(block);
    assert.equal(block.data, bytes.toString('base64'));
    const {
      id: _id,
      reference: _reference,
      merged_from: _merged,
      created: _created,
      updated: _updated,
      done: _done,
      source_ids: _sources,
      own_remark: _remark,
      ...details
    } = evidence.task;
    const input = {
      ...details,
      id: task.reference,
      expected_revision: evidence.revision,
      priority: 'low',
      triage_state: 'needs_info',
      blocking_question: 'Which outcome is needed first?',
    };
    const before = f.store.snapshot();
    const saved = await client.callTool({ name: 'triage_task', arguments: input });
    assert.notEqual(saved.isError, true);
    const updated = EvidenceSchema.parse(saved.structuredContent);
    assert.equal(updated.task.triage_state, 'needs_info');
    assert.equal(updated.task.own_remark, evidence.task.own_remark);
    assert.equal(updated.task.done, evidence.task.done);
    assert.deepEqual(updated.task.source_ids, evidence.task.source_ids);
    assert.deepEqual(f.store.snapshot().usage, before.usage);
    const stale = await client.callTool({ name: 'triage_task', arguments: input });
    assert.equal(stale.isError, true);
    const forbidden = await client.callTool({
      name: 'triage_task',
      arguments: { ...input, expected_revision: updated.revision, done: true },
    });
    assert.equal(forbidden.isError, true);
    const invalid = await client.callTool({
      name: 'triage_task',
      arguments: { ...input, expected_revision: updated.revision, blocking_question: null },
    });
    assert.equal(invalid.isError, true);
    assert.deepEqual(f.store.taskEvidence(task.id), updated);
    const missing = await client.callTool({ name: 'get_task', arguments: { id: 'missing' } });
    assert.equal(missing.isError, true);
    const output = JSON.stringify([
      catalog,
      open,
      evidence,
      chats,
      conversation,
      saved,
      stale,
      forbidden,
    ]);
    assert.ok(!output.includes('private-provider-key'));
    assert.ok(!output.includes(token));
  } finally {
    await client.close();
    await f.close();
  }
});

test('MCP requires its dedicated token and rejects browser origins outside the workspace', async () => {
  const f = await fixture();
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  try {
    for (const Authorization of ['', 'Bearer incorrect', 'Basic YWRtaW46cGFzc3dvcmQ=']) {
      const response = await fetch(f.url, {
        method: 'POST',
        headers: { ...headers, Authorization },
        body,
      });
      assert.equal(response.status, 401);
      assert.match(response.headers.get('www-authenticate') ?? '', /Bearer/);
      await response.text();
    }
    const rejected = await fetch(f.url, {
      method: 'POST',
      headers: {
        ...headers,
        Authorization: `Bearer ${token}`,
        Origin: 'https://untrusted.example',
      },
      body,
    });
    assert.equal(rejected.status, 403);
    await rejected.text();
    const allowed = await fetch(f.url, {
      method: 'POST',
      headers: {
        ...headers,
        Authorization: `Bearer ${token}`,
        Origin: 'https://tasks.example.com',
      },
      body,
    });
    assert.equal(allowed.status, 200);
    await allowed.text();
    const unsupported = await fetch(f.url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(unsupported.status, 405);
    await unsupported.text();
  } finally {
    await f.close();
  }
});

test('MCP stays disabled without a configured token', async () => {
  const f = await fixture(false);
  try {
    const response = await fetch(f.url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 404);
    assert.ok(!(await response.text()).includes('source_ids'));
  } finally {
    await f.close();
  }
});
