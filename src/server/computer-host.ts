import { z } from 'zod';
import type { ComputerProvider, PlatformConfig } from './platform-config.js';
export interface ComputerEndpoint {
  origin: string;
  /** Infrastructure authentication, held only by the server. */
  headers?: Record<string, string>;
}
/**
 * Where a Dot's computer runs. The computer itself is always OpenBot's computer
 * service (browser, files, shell over HTTP); a host only provisions it, finds its
 * origin, and stops it. ComputerService owns policy, audit and per-Dot credentials.
 */
export interface ComputerHost {
  readonly provider: ComputerProvider;
  readonly configured: boolean;
  /** Secrets this host holds, redacted from anything an upstream response echoes. */
  readonly secrets: string[];
  /** The running computer's service origin, or undefined when it is stopped. Never provisions. */
  running(
    id: string,
    signal?: AbortSignal,
  ): Promise<ComputerEndpoint | undefined>;
  /** Start or resume the Dot's computer and return its service origin. */
  ensure(id: string, signal?: AbortSignal): Promise<ComputerEndpoint>;
  stop(id: string, signal?: AbortSignal): Promise<void>;
}
const stateSchema = z.object({
  botId: z.string(),
  container: z.string(),
  status: z.string(),
  port: z.number().int().min(1024).max(65535).optional(),
  url: z.string().optional(),
});
export type SupervisorRequest = (
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
/** OpenBot's Docker supervisor: one container per Dot, reached by container DNS or a loopback port. */
export class SupervisorHost implements ComputerHost {
  readonly provider = 'openbot' as const;
  constructor(
    private config: PlatformConfig,
    private request: SupervisorRequest,
  ) {}
  get configured() {
    return !!(
      this.config.computerSupervisorUrl?.trim() &&
      this.config.computerSupervisorToken?.trim() &&
      this.config.computerToken?.trim()
    );
  }
  get secrets() {
    return [this.config.computerSupervisorToken?.trim()].filter(
      (s): s is string => !!s,
    );
  }
  private endpoint(id: string, raw: unknown) {
    const state = stateSchema.parse(raw);
    const ns = this.config.computerNamespace ?? 'opendots';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(ns))
      throw new Error('Invalid computer namespace.');
    const expected = `${ns}-computer-${id}`;
    if (state.botId !== id || state.container !== expected)
      throw new Error('Computer identity mismatch.');
    const url = new URL(
      state.url ??
        (state.port
          ? `http://127.0.0.1:${state.port}`
          : `http://${expected}:4100`),
    );
    const network =
      url.hostname === expected.toLowerCase() && url.port === '4100';
    const local =
      url.hostname === '127.0.0.1' &&
      !!state.port &&
      url.port === String(state.port) &&
      new URL(this.config.computerSupervisorUrl!).hostname === '127.0.0.1';
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (!network && !local)
    )
      throw new Error('Computer endpoint is not bound to this Dot.');
    return { origin: url.origin };
  }
  private async existing(id: string, signal?: AbortSignal) {
    const listing = z
      .object({ computers: z.array(stateSchema) })
      .parse(await this.request('/computers', undefined, signal));
    return listing.computers.find((c) => c.botId === id);
  }
  async running(id: string, signal?: AbortSignal) {
    const state = await this.existing(id, signal);
    if (!state || state.status !== 'running') return undefined;
    return this.endpoint(id, state);
  }
  async ensure(id: string, signal?: AbortSignal) {
    return this.endpoint(
      id,
      await this.request(`/computers/${id}/ensure`, {}, signal),
    );
  }
  async stop(id: string, signal?: AbortSignal) {
    await this.request(`/computers/${id}/stop`, {}, signal);
  }
}
