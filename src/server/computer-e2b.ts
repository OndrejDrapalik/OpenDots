import { createHash, randomUUID } from 'node:crypto';
import type { ComputerEndpoint, ComputerHost } from './computer-host.js';
import type {
  ComputerLease,
  ComputerStore,
  E2BComputerBinding,
} from './computer-store.js';
import type { PlatformConfig } from './platform-config.js';

const sdk = () => import('e2b');
export const servicePort = 4100;
const idleMs = 15 * 60_000;
const controlMs = 10_000;
const user = 'user';
const health = `curl -sf -m 2 http://127.0.0.1:${servicePort}/health >/dev/null`;
const waitForHealth = `for i in $(seq 90); do ${health} && exit 0; sleep 0.5; done; exit 1`;
// Includes the legacy launch command. SIGTERM invokes OpenBot's browser flush;
// never escalate to SIGKILL and claim that the profile was saved.
export const shutdownService = `pids=$(pgrep -f '^(/usr/local/bin/)?bun src/index.ts$' || true)
for pid in $pids; do kill -TERM "$pid" || exit 1; done
for i in $(seq 90); do
  alive=0
  for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive=1; done
  [ "$alive" = 0 ] && exit 0
  sleep 0.5
done
exit 1`;

export interface SandboxSummary {
  sandboxId: string;
  templateId: string;
  name?: string;
  state: 'running' | 'paused';
  endAt: Date;
  metadata: Record<string, string>;
  network?: { allowPublicTraffic?: boolean };
  lifecycle?: { onTimeout: string; autoResume: boolean };
}
export interface SandboxBox {
  trafficAccessToken?: string;
  host(port: number): string;
  exec(command: string, asUser: string, timeoutMs: number): Promise<number>;
  spawn(command: string, envs: Record<string, string>): Promise<void>;
}
export interface SandboxDriver {
  list(
    metadata: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string[]>;
  info(sandboxId: string, signal?: AbortSignal): Promise<SandboxSummary>;
  resolve(template: string, signal?: AbortSignal): Promise<string>;
  create(
    template: string,
    metadata: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string>;
  pause(sandboxId: string, signal?: AbortSignal): Promise<void>;
  connect(
    sandboxId: string,
    timeoutMs: number,
    signal?: AbortSignal,
    reboot?: boolean,
  ): Promise<SandboxBox>;
  keepAlive(
    sandboxId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void>;
  copyData(
    sourceId: string,
    destinationId: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export function e2bDriver(config: PlatformConfig, load = sdk): SandboxDriver {
  const opts = (signal?: AbortSignal) => ({
    apiKey: config.e2bApiKey,
    ...(config.e2bDomain ? { domain: config.e2bDomain } : {}),
    requestTimeoutMs: controlMs,
    signal,
  });
  return {
    async list(metadata, signal) {
      const { Sandbox } = await load();
      const pages = Sandbox.list({
        ...opts(signal),
        query: { metadata, state: ['running', 'paused'] },
      });
      const ids: string[] = [];
      while (pages.hasNext)
        ids.push(...(await pages.nextItems()).map((item) => item.sandboxId));
      return ids;
    },
    async info(sandboxId, signal) {
      const { Sandbox } = await load();
      return Sandbox.getInfo(sandboxId, opts(signal));
    },
    async resolve(template, signal) {
      const { Template } = await load();
      const [name, tag = 'default'] = template.split(':');
      // E2B accepts immutable build UUIDs in the same position as a named tag.
      if (
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          tag,
        )
      )
        return tag;
      const build = (await Template.getTags(name, opts(signal))).find(
        (item) => item.tag === tag,
      );
      if (!build)
        throw new Error(
          'Computer template tag does not exist. Build the template first.',
        );
      return build.buildId;
    },
    async create(template, metadata, signal) {
      const { Sandbox } = await load();
      const box = await Sandbox.create(template, {
        ...opts(signal),
        requestTimeoutMs: 60_000,
        metadata,
        timeoutMs: idleMs,
        network: { allowPublicTraffic: false },
        // Idle pause preserves application buffers, including Chromium cookie
        // writes. Explicit Stop flushes the service before a filesystem-only pause.
        lifecycle: { onTimeout: 'pause', autoResume: false },
      });
      return box.sandboxId;
    },
    async pause(sandboxId, signal) {
      const { Sandbox } = await load();
      await Sandbox.pause(sandboxId, { ...opts(signal), keepMemory: false });
    },
    async keepAlive(sandboxId, timeoutMs, signal) {
      const { Sandbox } = await load();
      await Sandbox.setTimeout(sandboxId, timeoutMs, opts(signal));
    },
    async connect(sandboxId, timeoutMs, signal, reboot = false) {
      const { CommandExitError, Sandbox } = await load();
      const box = await Sandbox.connect(sandboxId, {
        ...opts(signal),
        timeoutMs,
        ...(reboot ? { onResume: 'reboot' as const } : {}),
      });
      return {
        trafficAccessToken: box.trafficAccessToken,
        host: (port) => box.getHost(port),
        async exec(command, asUser, timeoutMs) {
          try {
            return (
              await box.commands.run(command, {
                user: asUser,
                timeoutMs,
                signal,
              })
            ).exitCode;
          } catch (error) {
            if (error instanceof CommandExitError) return error.exitCode;
            throw error;
          }
        },
        async spawn(command, envs) {
          await box.commands.run(command, {
            user,
            cwd: '/app',
            envs,
            background: true,
            timeoutMs: 0,
            signal,
          });
        },
      };
    },
    async copyData(sourceId, destinationId, signal) {
      const { Sandbox } = await load();
      const transfer = new AbortController();
      const active = signal
        ? AbortSignal.any([signal, transfer.signal])
        : transfer.signal;
      const source = await Sandbox.connect(sourceId, {
        ...opts(active),
        timeoutMs: idleMs,
        onResume: 'reboot',
      });
      const target = await Sandbox.connect(destinationId, {
        ...opts(active),
        timeoutMs: idleMs,
      });
      const archive = `/tmp/opendots-${randomUUID()}.tar.gz`;
      const staging = `/tmp/opendots-${randomUUID()}`;
      let renewal: Promise<unknown> | undefined;
      const heartbeat = setInterval(() => {
        if (renewal) return;
        renewal = Promise.all([
          Sandbox.setTimeout(sourceId, idleMs, opts(active)),
          Sandbox.setTimeout(destinationId, idleMs, opts(active)),
        ])
          .catch((error) => {
            transfer.abort(error);
          })
          .finally(() => {
            renewal = undefined;
          });
      }, 60_000);
      const transferOpts = { signal: active, requestTimeoutMs: 600_000 };
      try {
        await source.commands.run(
          `tar -czf ${archive} -C / workspace profiles`,
          { user: 'root', timeoutMs: 600_000, ...transferOpts },
        );
        // Streams avoid buffering entire profiles in the OpenDots process.
        const stream = await source.files.read(archive, {
          user: 'root',
          format: 'stream',
          ...transferOpts,
        });
        try {
          await target.files.write(archive, stream, {
            user: 'root',
            ...transferOpts,
          });
        } finally {
          if (!stream.locked) await stream.cancel();
        }
        await target.commands.run(
          `mkdir -p ${staging} /workspace /profiles && chown ${user}:${user} ${staging} /workspace /profiles && chmod a+r ${archive}`,
          { user: 'root', ...transferOpts },
        );
        // Extract as the unprivileged user. GNU tar rejects traversal; require
        // real top-level directories before moving their contents into place.
        await target.commands.run(
          `tar -xzf ${archive} -C ${staging} --no-same-owner --no-same-permissions && test -d ${staging}/workspace && test ! -L ${staging}/workspace && test -d ${staging}/profiles && test ! -L ${staging}/profiles && cp -a ${staging}/workspace/. /workspace/ && cp -a ${staging}/profiles/. /profiles/`,
          { user, timeoutMs: 600_000, ...transferOpts },
        );
        active.throwIfAborted();
      } finally {
        clearInterval(heartbeat);
        transfer.abort();
        await renewal;
        // Best effort: a failed copy leaves the original sandbox intact.
        await Promise.allSettled([
          source.files.remove(archive, { user: 'root' }),
          target.files.remove(archive, { user: 'root' }),
          target.files.remove(staging, { user: 'root' }),
        ]);
      }
    },
  };
}
export function sandboxLabels(namespace: string, id: string) {
  return { 'opendots-namespace': namespace, 'opendots-dot': id };
}

export class E2BHost implements ComputerHost {
  readonly provider = 'e2b' as const;
  constructor(
    private config: PlatformConfig,
    private token: (id: string) => string,
    private store: ComputerStore,
    private driver: SandboxDriver = e2bDriver(config),
  ) {
    if (config.computerToken && config.computerToken.trim().length < 24)
      throw new Error('COMPUTER_TOKEN must contain at least 24 characters.');
  }
  get configured() {
    return !!(
      this.config.e2bApiKey?.trim() && this.config.computerToken?.trim()
    );
  }
  get secrets() {
    return [this.config.e2bApiKey?.trim()].filter((s): s is string => !!s);
  }
  template() {
    const template = this.config.computerE2bTemplate ?? 'opendots-computer';
    if (
      template.length > 251 ||
      !/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)?(?::[A-Za-z0-9][A-Za-z0-9_.-]*)?$/.test(
        template,
      )
    )
      throw new Error('Computer template reference is invalid.');
    return template;
  }
  private labels(id: string) {
    const ns = this.config.computerNamespace ?? 'opendots';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(ns))
      throw new Error('Computer namespace is invalid.');
    return sandboxLabels(ns, id);
  }
  private key(id: string) {
    return `${this.labels(id)['opendots-namespace']}:${id}`;
  }
  private credentialHash(id: string) {
    return createHash('sha256').update(this.token(id)).digest('hex');
  }
  private async control<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof Error && /^Computer /.test(error.message))
        throw error;
      throw new Error(
        'E2B sandbox operation failed. Check E2B_API_KEY and COMPUTER_E2B_TEMPLATE.',
        { cause: error },
      );
    }
  }
  private async owned(id: string, sandboxId: string, signal?: AbortSignal) {
    const info = await this.driver.info(sandboxId, signal);
    const labels = this.labels(id);
    if (
      Object.keys(info.metadata).length !== Object.keys(labels).length ||
      !Object.entries(labels).every(([k, v]) => info.metadata[k] === v) ||
      info.lifecycle?.onTimeout !== 'pause' ||
      info.lifecycle.autoResume
    )
      throw new Error('Computer identity mismatch; refusing to attach.');
    // Desired software version is deliberately not an ownership check: owned
    // computers must remain stoppable after configuration or template changes.
    return info;
  }
  private awake(info: SandboxSummary) {
    return Math.max(
      idleMs,
      info.state === 'running' ? info.endAt.getTime() - Date.now() : 0,
    );
  }
  private endpoint(box: SandboxBox): ComputerEndpoint {
    const url = new URL(`https://${box.host(servicePort)}`);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !box.trafficAccessToken
    )
      throw new Error(
        'Computer ingress authentication is unavailable. Start the computer to upgrade it.',
      );
    return {
      origin: url.origin,
      headers: { 'e2b-traffic-access-token': box.trafficAccessToken },
    };
  }
  private async shutdown(box: SandboxBox) {
    if ((await box.exec(shutdownService, 'root', 60_000)) !== 0)
      throw new Error(
        'Computer service could not shut down gracefully; its sandbox was retained.',
      );
  }
  private async find(id: string, lease: ComputerLease) {
    const binding = this.store.e2bBinding(this.key(id));
    if (binding)
      return {
        binding,
        info: await this.owned(id, binding.sandboxId, lease.signal),
      };
    const ids = await this.driver.list(this.labels(id), lease.signal);
    if (ids.length > 1)
      throw new Error(
        'Computer has duplicate sandboxes. Stop remains available; select the data to retain before starting.',
      );
    if (!ids.length) return undefined;
    const info = await this.owned(id, ids[0], lease.signal);
    const adopted: E2BComputerBinding = {
      sandboxId: info.sandboxId,
      template: info.name ?? info.templateId,
      buildId: '',
      backups: [],
    };
    lease.save(adopted);
    return { binding: adopted, info };
  }
  async running(id: string, signal?: AbortSignal) {
    return this.control(() =>
      this.store.withE2bLease(
        this.key(id),
        async (lease) => {
          const found = await this.find(id, lease);
          if (
            !found ||
            found.info.state !== 'running' ||
            found.binding.migrationFrom ||
            found.info.network?.allowPublicTraffic !== false
          )
            return undefined;
          const { binding, info } = found;
          if (binding.credentialHash !== this.credentialHash(id)) {
            const box = await this.driver.connect(
              info.sandboxId,
              this.awake(info),
              lease.signal,
            );
            await this.shutdown(box);
            await this.driver.pause(info.sandboxId, lease.signal);
            lease.save({ ...binding, credentialHash: undefined });
            return undefined;
          }
          if (!binding.endpoint) return undefined;
          // setTimeout never resumes. connect() here would let a status poll undo an
          // idle pause if it raced the expiration deadline, particularly with memory snapshots.
          await this.driver.keepAlive(
            info.sandboxId,
            this.awake(info),
            lease.signal,
          );
          if (
            (await this.owned(id, info.sandboxId, lease.signal)).state !==
            'running'
          )
            return undefined;
          lease.check();
          return binding.endpoint;
        },
        signal,
      ),
    );
  }
  async ensure(id: string, signal?: AbortSignal) {
    return this.control(() =>
      this.store.withE2bLease(
        this.key(id),
        async (lease) => {
          const template = this.template();
          const buildId = await this.driver.resolve(template, lease.signal);
          let found = await this.find(id, lease);
          if (
            found &&
            !found.binding.migrationFrom &&
            (found.binding.buildId !== buildId ||
              found.binding.template !== template ||
              found.info.network?.allowPublicTraffic !== false)
          ) {
            const old = await this.driver.connect(
              found.info.sandboxId,
              this.awake(found.info),
              lease.signal,
            );
            await this.shutdown(old);
            await this.driver.pause(found.info.sandboxId, lease.signal);
            lease.check();
            const sandboxId = await this.driver.create(
              `${template.split(':')[0]}:${buildId}`,
              this.labels(id),
              lease.signal,
            );
            const binding = {
              sandboxId,
              template,
              buildId,
              migrationFrom: found.info.sandboxId,
              backups: found.binding.backups,
            };
            lease.save(binding);
            found = {
              binding,
              info: await this.owned(id, sandboxId, lease.signal),
            };
          }
          if (!found) {
            const sandboxId = await this.driver.create(
              `${template.split(':')[0]}:${buildId}`,
              this.labels(id),
              lease.signal,
            );
            const binding = { sandboxId, template, buildId, backups: [] };
            lease.save(binding);
            found = {
              binding,
              info: await this.owned(id, sandboxId, lease.signal),
            };
          }
          let { binding } = found;
          const box = await this.driver.connect(
            binding.sandboxId,
            this.awake(found.info),
            lease.signal,
          );
          // Check ingress before ever launching a service in the new sandbox.
          const endpoint = this.endpoint(box);
          if (binding.migrationFrom) {
            await this.shutdown(box);
            await this.owned(id, binding.migrationFrom, lease.signal);
            try {
              await this.driver.copyData(
                binding.migrationFrom,
                binding.sandboxId,
                lease.signal,
              );
            } finally {
              lease.check();
              await this.driver.pause(binding.migrationFrom, lease.signal);
            }
          }
          if (
            binding.credentialHash !== this.credentialHash(id) ||
            (await box.exec(health, user, 10_000)) !== 0
          ) {
            await this.shutdown(box);
            if (
              (await box.exec(
                `mkdir -p /workspace /profiles && chown ${user}:${user} /workspace /profiles`,
                'root',
                30_000,
              )) !== 0
            )
              throw new Error('Computer workspace could not be prepared.');
            await box.spawn('exec /usr/local/bin/bun src/index.ts', {
              COMPUTER_BOT_ID: id,
              COMPUTER_TOKEN: this.token(id),
              COMPUTER_BROWSER_MODE: 'headless',
              PORT: String(servicePort),
              WORKSPACE_DIR: '/workspace',
              PROFILES_DIR: '/profiles',
              PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
            });
            if ((await box.exec(waitForHealth, user, 60_000)) !== 0)
              throw new Error('Computer service did not start in the sandbox.');
          }
          binding = {
            ...binding,
            endpoint,
            credentialHash: this.credentialHash(id),
            backups: [
              ...binding.backups,
              ...(binding.migrationFrom ? [binding.migrationFrom] : []),
            ],
            migrationFrom: undefined,
          };
          lease.save(binding);
          return endpoint;
        },
        signal,
      ),
    );
  }
  async stop(id: string, signal?: AbortSignal) {
    return this.control(() =>
      this.store.withE2bLease(
        this.key(id),
        async (lease) => {
          // Include legacy duplicates and retained upgrade backups. Stop never needs
          // the desired template to exist and never resumes an already-paused box.
          const ids = await this.driver.list(this.labels(id), lease.signal);
          const infos = await Promise.all(
            ids.map((sandboxId) => this.owned(id, sandboxId, lease.signal)),
          );
          for (const info of infos)
            if (info.state === 'running') {
              const box = await this.driver.connect(
                info.sandboxId,
                this.awake(info),
                lease.signal,
              );
              await this.shutdown(box);
              lease.check();
              await this.driver.pause(info.sandboxId, lease.signal);
            }
        },
        signal,
      ),
    );
  }
}
