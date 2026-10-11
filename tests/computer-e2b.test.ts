import { afterEach, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ComputerStore } from '../src/server/computer-store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
import {
  E2BHost,
  e2bDriver,
  sandboxLabels,
  shutdownService,
  type SandboxBox,
  type SandboxDriver,
  type SandboxSummary,
} from '../src/server/computer-e2b.js';
const stores: WorkspaceStore[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const apiKey = 'e2b-test-key-never-sent';
const namespace = 'opendots-test';
const buildV1 = '11111111-1111-4111-8111-111111111111';
const buildV2 = '22222222-2222-4222-8222-222222222222';
function fake(boxes: Partial<SandboxSummary>[] = [], id = 'dot') {
  const sandboxes = new Map<string, SandboxSummary>();
  const serviceUp = new Map<string, boolean>();
  const tokens = new Map<string, string>();
  const files = new Map<string, Record<string, string>>();
  const calls = {
    create: [] as { template: string; metadata: Record<string, string> }[],
    connect: [] as string[],
    pause: [] as string[],
    exec: [] as { sandboxId: string; command: string; user: string }[],
    spawn: [] as {
      sandboxId: string;
      command: string;
      envs: Record<string, string>;
    }[],
    copies: [] as [string, string][],
  };
  const state = {
    build: buildV1,
    copyFails: false,
    shutdownFails: false,
    ingressToken: 'traffic-secret',
    resolveFails: false,
  };
  const add = (info: Partial<SandboxSummary>, up = true) => {
    const sandboxId = info.sandboxId ?? `sbx-${sandboxes.size + 1}`;
    sandboxes.set(sandboxId, {
      sandboxId,
      templateId: 'tpl-id',
      name: 'opendots-computer',
      state: 'running',
      endAt: new Date(Date.now() + 900_000),
      metadata: sandboxLabels(namespace, id),
      lifecycle: { onTimeout: 'pause', autoResume: false },
      network: { allowPublicTraffic: false },
      ...info,
    });
    serviceUp.set(sandboxId, up && (info.state ?? 'running') === 'running');
    files.set(sandboxId, {});
    return sandboxId;
  };
  for (const info of boxes) add(info);
  const box = (sandboxId: string): SandboxBox => ({
    get trafficAccessToken() {
      return state.ingressToken || undefined;
    },
    host: (port) => `${port}-${sandboxId}.e2b.test`,
    async exec(command, user) {
      calls.exec.push({ sandboxId, command, user });
      if (command === shutdownService) {
        if (state.shutdownFails) return 1;
        serviceUp.set(sandboxId, false);
        tokens.delete(sandboxId);
      }
      if (command.includes('/health')) return serviceUp.get(sandboxId) ? 0 : 1;
      return 0;
    },
    async spawn(command, envs) {
      calls.spawn.push({ sandboxId, command, envs });
      serviceUp.set(sandboxId, true);
      tokens.set(sandboxId, envs.COMPUTER_TOKEN);
    },
  });
  const driver: SandboxDriver = {
    async list(metadata) {
      return [...sandboxes.values()]
        .filter((s) =>
          Object.entries(metadata).every(([k, v]) => s.metadata[k] === v),
        )
        .map((s) => s.sandboxId);
    },
    async info(sandboxId) {
      return sandboxes.get(sandboxId)!;
    },
    async resolve() {
      if (state.resolveFails) throw new Error('unavailable template');
      return state.build;
    },
    async create(template, metadata) {
      calls.create.push({ template, metadata });
      return add({ metadata, name: template.split(':')[0] }, false);
    },
    async pause(sandboxId) {
      calls.pause.push(sandboxId);
      sandboxes.get(sandboxId)!.state = 'paused';
      serviceUp.set(sandboxId, false);
    },
    async connect(sandboxId) {
      calls.connect.push(sandboxId);
      sandboxes.get(sandboxId)!.state = 'running';
      return box(sandboxId);
    },
    async keepAlive(sandboxId) {
      if (sandboxes.get(sandboxId)!.state !== 'running')
        throw new Error('sandbox paused');
    },
    async copyData(sourceId, destinationId) {
      calls.copies.push([sourceId, destinationId]);
      if (state.copyFails) throw new Error('transfer interrupted');
      files.set(destinationId, structuredClone(files.get(sourceId)!));
    },
  };
  return { driver, calls, sandboxes, serviceUp, tokens, files, state };
}
async function fixture(
  boxes: Partial<SandboxSummary>[] = [],
  withKey = true,
  managed = true,
) {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  const id = workspace.dots()[0].id;
  const e2b = fake(boxes, id);
  const requests: { url: string; init?: RequestInit }[] = [];
  let upstream: () => Response = () => Response.json({ text: 'result' });
  const transport: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (
      String(input).endsWith('/control') &&
      !e2b.serviceUp.get(
        new URL(String(input)).hostname
          .replace(/^4100-/, '')
          .replace(/\.e2b\.test$/, ''),
      )
    )
      return new Response(null, { status: 502 });
    if (String(input).endsWith('/control'))
      return Response.json({
        holder: 'bot',
        requested: false,
        transitioning: false,
        resumeSnapshotRequired: false,
      });
    return upstream();
  };
  const config = {
    baseUrl: 'https://example.com',
    voiceName: 'voice',
    slackUsers: [],
    runtimeUrl: 'http://localhost',
    computerProvider: 'e2b' as const,
    computerToken: 'master-secret-master-secret',
    computerNamespace: namespace,
    e2bApiKey: withKey ? apiKey : undefined,
    computerE2bTemplate: 'opendots-computer',
  };
  const token = (dot: string) =>
    createHmac('sha256', config.computerToken)
      .update(`opendots-computer:${dot}`)
      .digest('hex');
  if (managed && boxes.length === 1)
    await workspace.computers.withE2bLease(
      `${namespace}:${id}`,
      async (lease) => {
        const sandboxId = [...e2b.sandboxes.keys()][0];
        lease.save({
          sandboxId,
          template: config.computerE2bTemplate,
          buildId: buildV1,
          credentialHash: createHash('sha256').update(token(id)).digest('hex'),
          backups: [],
          endpoint: {
            origin: `https://4100-${sandboxId}.e2b.test`,
            headers: { 'e2b-traffic-access-token': 'traffic-secret' },
          },
        });
        e2b.tokens.set(sandboxId, token(id));
      },
    );
  const host = new E2BHost(config, token, workspace.computers, e2b.driver);
  const service = new ComputerService(
    workspace,
    config,
    () => false,
    transport,
    1000,
    host,
  );
  workspace.computers.patch(id, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });
  return {
    id,
    service,
    host,
    e2b,
    requests,
    token,
    config,
    workspace,
    respond: (fn: () => Response) => {
      upstream = fn;
    },
  };
}
it('creates one sandbox pinned to a build and routes every request with server-only ingress authentication', async () => {
  const f = await fixture();
  expect(await f.service.status(f.id)).toMatchObject({
    configured: true,
    provider: 'e2b',
    state: 'stopped',
  });
  expect(f.e2b.calls.connect).toEqual([]);
  expect((await f.service.start(f.id)).state).toBe('running');
  expect(f.e2b.calls.create).toEqual([
    {
      template: `opendots-computer:${buildV1}`,
      metadata: sandboxLabels(namespace, f.id),
    },
  ]);
  expect(
    f.e2b.calls.exec.find((c) => c.command.includes('chown')),
  ).toMatchObject({ user: 'root' });
  const [launch] = f.e2b.calls.spawn;
  expect(launch.command).toBe('exec /usr/local/bin/bun src/index.ts');
  expect(launch.envs).toMatchObject({
    COMPUTER_BOT_ID: f.id,
    COMPUTER_TOKEN: f.token(f.id),
    COMPUTER_BROWSER_MODE: 'headless',
    PORT: '4100',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
  });
  expect(JSON.stringify(launch.envs)).not.toContain(f.config.computerToken);
  expect(JSON.stringify(launch.envs)).not.toContain(apiKey);
  expect(JSON.stringify(launch.envs)).not.toContain(f.e2b.state.ingressToken);
  await f.service.action(f.id, 'files_read', { path: 'note.txt' }, 'agent');
  const request = f.requests.at(-1)!;
  expect(request.url).toBe('https://4100-sbx-1.e2b.test/files/read');
  expect(new Headers(request.init?.headers).get('authorization')).toBe(
    `Bearer ${f.token(f.id)}`,
  );
  expect(
    f.requests.every(
      (r) =>
        new Headers(r.init?.headers).get('e2b-traffic-access-token') ===
        'traffic-secret',
    ),
  ).toBe(true);
  f.respond(() =>
    Response.json({ text: `${apiKey} traffic-secret ${f.token(f.id)}` }),
  );
  expect(await f.service.action(f.id, 'read', {})).toEqual({
    text: '[redacted] [redacted] [redacted]',
  });
  await f.service.start(f.id);
  expect(f.e2b.calls.create).toHaveLength(1);
  expect(f.e2b.calls.spawn).toHaveLength(1);
});
it('flushes the service before explicit Stop, preserves files, and resumes on Start only', async () => {
  const f = await fixture([{ sandboxId: 'kept', state: 'paused' }]);
  f.e2b.files.get('kept')!['note.txt'] = 'durable';
  expect((await f.service.status(f.id)).state).toBe('stopped');
  expect(f.e2b.calls.connect).toEqual([]);
  await f.service.start(f.id);
  expect(f.e2b.calls.create).toEqual([]);
  await f.service.stop(f.id);
  expect(f.e2b.calls.pause).toEqual(['kept']);
  expect(f.e2b.serviceUp.get('kept')).toBe(false);
  expect(f.e2b.files.get('kept')).toEqual({ 'note.txt': 'durable' });
  const count = f.e2b.calls.connect.length;
  await f.service.stop(f.id);
  expect(f.e2b.calls.connect).toHaveLength(count);
  await expect(f.service.action(f.id, 'read', {})).rejects.toThrow(
    'Start this Dot',
  );
});
it('fails closed on ownership and lifecycle mismatches', async () => {
  for (const foreign of [
    { metadata: { ...sandboxLabels(namespace, 'dot'), extra: 'x' } },
    { lifecycle: { onTimeout: 'kill', autoResume: false } },
    { lifecycle: { onTimeout: 'pause', autoResume: true } },
  ]) {
    const f = await fixture([foreign]);
    if (foreign.metadata)
      [...f.e2b.sandboxes.values()][0].metadata = {
        ...sandboxLabels(namespace, f.id),
        extra: 'x',
      };
    await expect(f.host.running(f.id)).rejects.toThrow('identity mismatch');
    await expect(f.service.start(f.id)).rejects.toThrow('identity mismatch');
    expect(f.e2b.calls.connect).toEqual([]);
  }
});
it('stops legacy duplicates without choosing or deleting either dataset', async () => {
  const f = await fixture([{ sandboxId: 'a' }, { sandboxId: 'b' }]);
  await expect(f.host.ensure(f.id)).rejects.toThrow('duplicate sandboxes');
  await f.host.stop(f.id);
  expect(f.e2b.calls.pause).toEqual(['a', 'b']);
  expect(f.e2b.sandboxes.size).toBe(2);
});
it('does not pause a computer merely because its service is unavailable', async () => {
  const f = await fixture([{ sandboxId: 'race' }]);
  f.e2b.serviceUp.set('race', false);
  expect((await f.service.status(f.id)).state).toBe('unavailable');
  expect(f.e2b.calls.pause).toEqual([]);
  await f.service.start(f.id);
  expect(f.e2b.calls.spawn).toHaveLength(1);
});
it('does not resume a memory snapshot when an idle pause races a status poll', async () => {
  const f = await fixture([{ sandboxId: 'idle-race' }]);
  f.e2b.driver.keepAlive = async (sandboxId) => {
    f.e2b.sandboxes.get(sandboxId)!.state = 'paused';
  };
  expect((await f.service.status(f.id)).state).toBe('stopped');
  expect(f.e2b.calls.connect).toEqual([]);
  expect(f.requests).toEqual([]);
});
it('serializes starts across independently constructed hosts', async () => {
  const f = await fixture();
  const other = new E2BHost(
    f.config,
    f.token,
    f.workspace.computers,
    f.e2b.driver,
  );
  await Promise.all([
    f.host.ensure(f.id),
    other.ensure(f.id),
    f.service.start(f.id),
  ]);
  expect(f.e2b.calls.create).toHaveLength(1);
  expect(f.e2b.calls.spawn).toHaveLength(1);
  await f.service.stop(f.id);
  expect(f.e2b.calls.pause).toHaveLength(1);
});
it('uses a database lease across separate SQLite connections and releases it after failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opendots-lease-'));
  directories.push(directory);
  const a = new WorkspaceStore(join(directory, 'workspace.sqlite'), 'owner');
  stores.push(a);
  const b = new WorkspaceStore(join(directory, 'workspace.sqlite'), 'owner');
  stores.push(b);
  const order: string[] = [];
  const release = Promise.withResolvers<void>();
  const first = a.computers.withE2bLease('shared', async () => {
    order.push('a');
    await release.promise;
    throw new Error('failure');
  });
  const caught = first.catch((e) => e.message);
  const second = b.computers.withE2bLease('shared', async () => {
    order.push('b');
  });
  await Promise.resolve();
  expect(order).toEqual(['a']);
  release.resolve();
  expect(await caught).toBe('failure');
  await second;
  expect(order).toEqual(['a', 'b']);
});
it('waits for an in-flight start before Stop', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = f.e2b.driver.connect;
  f.e2b.driver.connect = async (...args) => {
    const box = await original(...args);
    const spawn = box.spawn;
    box.spawn = async (...input) => {
      entered.resolve();
      await release.promise;
      await spawn(...input);
    };
    return box;
  };
  const start = f.host.ensure(f.id);
  await entered.promise;
  const stop = f.host.stop(f.id);
  release.resolve();
  await Promise.all([start, stop]);
  expect(f.e2b.sandboxes.get('sbx-1')!.state).toBe('paused');
});
it('fences an expired lease without letting its cleanup release the replacement owner', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new ComputerStore(db);
  const releaseFirst = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  const binding = {
    sandboxId: 'kept',
    template: 'computer',
    buildId: buildV1,
    backups: [],
  };
  try {
    const first = store.withE2bLease('shared', async (lease) => {
      await releaseFirst.promise;
      lease.save(binding);
    });
    const failure = first.catch((error) => error.message);
    db.prepare('UPDATE computer_e2b_leases SET expiresAt=0 WHERE key=?').run(
      'shared',
    );
    const second = store.withE2bLease('shared', async (lease) => {
      await releaseSecond.promise;
      lease.save(binding);
    });
    releaseFirst.resolve();
    expect(await failure).toContain('lease was lost');
    expect(store.e2bBinding('shared')).toBeUndefined();
    expect(
      db.prepare('SELECT key FROM computer_e2b_leases').get(),
    ).toMatchObject({ key: 'shared' });
    releaseSecond.resolve();
    await second;
    expect(store.e2bBinding('shared')).toEqual(binding);
    expect(
      db.prepare('SELECT key FROM computer_e2b_leases').get(),
    ).toBeUndefined();
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    db.close();
  }
});
it('revokes an old service credential on status and installs the new credential on Start', async () => {
  const f = await fixture();
  await f.service.start(f.id);
  const oldToken = f.token(f.id);
  f.config.computerToken = 'rotated-secret-rotated-secret';
  expect((await f.service.status(f.id)).state).toBe('stopped');
  expect([...f.e2b.tokens.values()]).not.toContain(oldToken);
  await f.service.start(f.id);
  expect(f.e2b.tokens.get('sbx-1')).toBe(f.token(f.id));
  expect(f.e2b.calls.create).toHaveLength(1);
});
it('upgrades a rebuilt alias with copied data and a paused backup, and persists the selected sandbox', async () => {
  const f = await fixture();
  await f.service.start(f.id);
  f.e2b.files.get('sbx-1')!['note'] = 'notes';
  f.e2b.files.get('sbx-1')!['profile/Cookies'] = 'persistent login';
  f.e2b.state.build = buildV2;
  await f.service.start(f.id);
  expect(f.e2b.calls.copies).toEqual([['sbx-1', 'sbx-2']]);
  expect(f.e2b.files.get('sbx-2')).toEqual(f.e2b.files.get('sbx-1'));
  expect(f.e2b.sandboxes.get('sbx-1')!.state).toBe('paused');
  const restarted = new E2BHost(
    f.config,
    f.token,
    f.workspace.computers,
    f.e2b.driver,
  );
  expect((await restarted.running(f.id))!.origin).toContain('sbx-2');
  await restarted.ensure(f.id);
  expect(f.e2b.calls.create).toHaveLength(2);
});
it('accepts namespaced version tags and keeps Stop available when the desired template cannot resolve', async () => {
  const f = await fixture();
  await f.service.start(f.id);
  f.config.computerE2bTemplate = 'team/opendots-computer:v2.0.0';
  f.e2b.state.build = buildV2;
  await f.service.start(f.id);
  expect(f.e2b.calls.create.at(-1)!.template).toBe(
    `team/opendots-computer:${buildV2}`,
  );
  f.config.computerE2bTemplate = 'missing-template:v3';
  f.e2b.state.resolveFails = true;
  await f.service.stop(f.id);
  expect(f.e2b.sandboxes.get('sbx-2')!.state).toBe('paused');
});
it('keeps a failed migration inaccessible and retries without losing the original files', async () => {
  const f = await fixture();
  await f.service.start(f.id);
  f.e2b.files.get('sbx-1')!['note'] = 'irreplaceable';
  f.e2b.state.build = buildV2;
  f.e2b.state.copyFails = true;
  await expect(f.service.start(f.id)).rejects.toThrow(
    'E2B sandbox operation failed',
  );
  expect((await f.service.status(f.id)).state).toBe('stopped');
  expect(f.e2b.files.get('sbx-1')!['note']).toBe('irreplaceable');
  expect(f.e2b.sandboxes.get('sbx-1')!.state).toBe('paused');
  f.e2b.state.copyFails = false;
  await f.service.start(f.id);
  expect(f.e2b.files.get('sbx-2')!['note']).toBe('irreplaceable');
  expect(f.e2b.calls.create).toHaveLength(2);
});
it('migrates public legacy sandboxes before serving any endpoint', async () => {
  const f = await fixture(
    [{ sandboxId: 'legacy', network: { allowPublicTraffic: true } }],
    true,
    false,
  );
  expect((await f.service.status(f.id)).state).toBe('stopped');
  expect(f.requests).toEqual([]);
  await f.service.start(f.id);
  expect(f.e2b.calls.copies).toEqual([['legacy', 'sbx-2']]);
  expect(f.e2b.sandboxes.get('legacy')!.state).toBe('paused');
});
it('refuses to launch without an ingress token and refuses to pause after a failed graceful shutdown', async () => {
  const f = await fixture();
  f.e2b.state.ingressToken = '';
  await expect(f.host.ensure(f.id)).rejects.toThrow('ingress authentication');
  expect(f.e2b.calls.spawn).toEqual([]);
  f.e2b.state.ingressToken = 'traffic-secret';
  await f.host.ensure(f.id);
  f.e2b.state.shutdownFails = true;
  await expect(f.host.stop(f.id)).rejects.toThrow('shut down gracefully');
  expect(f.e2b.calls.pause).toEqual([]);
});
it('reports missing API keys and rejects short master secrets for either provider', async () => {
  const f = await fixture([], false);
  expect(await f.service.status(f.id)).toMatchObject({
    configured: false,
    provider: 'e2b',
    state: 'not_configured',
  });
  await expect(f.service.start(f.id)).rejects.toThrow('not configured');
  for (const provider of ['e2b', 'openbot'] as const)
    expect(
      () =>
        new ComputerService(
          f.workspace,
          { ...f.config, computerProvider: provider, computerToken: 'short' },
          () => false,
        ),
    ).toThrow('at least 24');
});
it('uses the real SDK request serialization for private ingress, memory auto-pause, explicit disk pause and tagged builds', async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const path = req.url!;
    requests.push({ path, body: text ? JSON.parse(text) : {} });
    if (path.endsWith('/pause') || path.endsWith('/timeout')) {
      res.writeHead(204).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        path.endsWith('/tags')
          ? [
              {
                tag: 'production',
                buildID: buildV1,
                createdAt: new Date().toISOString(),
              },
            ]
          : {
              sandboxID: 'sdk-box',
              envdVersion: '0.4.0',
              envdAccessToken: 'envd-secret',
              trafficAccessToken: 'traffic-secret',
              domain: 'e2b.test',
            },
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test server address');
  vi.stubEnv('E2B_API_URL', `http://127.0.0.1:${address.port}`);
  try {
    const driver = e2bDriver({
      baseUrl: 'http://localhost',
      voiceName: '',
      slackUsers: [],
      runtimeUrl: '',
      e2bApiKey: 'e2b_test',
      e2bDomain: 'e2b.test',
    });
    expect(await driver.resolve('team/computer:production')).toBe(buildV1);
    expect(
      await driver.create(
        `team/computer:${buildV1}`,
        sandboxLabels(namespace, 'dot'),
      ),
    ).toBe('sdk-box');
    const body = requests.find((r) => r.path === '/v2/sandboxes')!.body;
    expect(body).toMatchObject({
      network: { allowPublicTraffic: false },
      autoPause: true,
      autoResume: { enabled: false },
      templateID: `team/computer:${buildV1}`,
    });
    expect(body.autoPauseMemory).not.toBe(false);
    const box = await driver.connect('sdk-box', 900_000);
    expect(box.trafficAccessToken).toBe('traffic-secret');
    await driver.keepAlive('sdk-box', 900_000);
    expect(requests.at(-1)!.path).toBe('/sandboxes/sdk-box/timeout');
    await driver.pause('sdk-box');
    expect(requests.at(-1)!.body).toMatchObject({ memory: false });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
it('streams profile transfers, extracts without root privileges, and cleans up after upload failures', async () => {
  const config = {
    baseUrl: 'http://localhost',
    voiceName: '',
    slackUsers: [],
    runtimeUrl: '',
    e2bApiKey: apiKey,
  };
  for (const fail of [false, true]) {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel,
    });
    const source = {
      commands: { run: vi.fn().mockResolvedValue({ exitCode: 0 }) },
      files: {
        read: vi.fn().mockResolvedValue(stream),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    };
    let received: number[] = [];
    const target = {
      commands: { run: vi.fn().mockResolvedValue({ exitCode: 0 }) },
      files: {
        remove: vi.fn().mockResolvedValue(undefined),
        write: vi.fn(
          async (
            _path,
            data: ReadableStream<Uint8Array>,
            options: { requestTimeoutMs: number },
          ) => {
            expect(options.requestTimeoutMs).toBeGreaterThan(10_000);
            expect(data).toBe(stream);
            if (fail) throw new Error('upload failed');
            const reader = data.getReader();
            try {
              received = [...(await reader.read()).value!];
            } finally {
              reader.releaseLock();
            }
          },
        ),
      },
    };
    const module = {
      Sandbox: {
        connect: vi.fn(async (id: string) =>
          id === 'source' ? source : target,
        ),
        setTimeout: vi.fn(),
      },
    } as unknown as typeof import('e2b');
    const copy = e2bDriver(config, async () => module).copyData(
      'source',
      'target',
    );
    if (fail) await expect(copy).rejects.toThrow('upload failed');
    else {
      await copy;
      expect(received).toEqual([1, 2, 3]);
      expect(target.commands.run.mock.calls.at(-1)![1].user).toBe('user');
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.files.remove).toHaveBeenCalledOnce();
    expect(target.files.remove).toHaveBeenCalledTimes(2);
  }
});
