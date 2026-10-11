import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ComputerEndpoint } from './computer-host.js';
import type {
  ComputerAudit,
  ComputerPermissions,
} from '../shared/computer-types.js';
export interface E2BComputerBinding {
  sandboxId: string;
  template: string;
  buildId: string;
  credentialHash?: string;
  endpoint?: ComputerEndpoint;
  /** An upgrade is not exposed to actions until the copy and launch finish. */
  migrationFrom?: string;
  backups: string[];
}
export interface ComputerLease {
  signal: AbortSignal;
  check(): void;
  save(binding: E2BComputerBinding): void;
}
export class ComputerStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS computer_permissions(dotId TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_audit(id TEXT PRIMARY KEY,dotId TEXT NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,outcome TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_e2b_bindings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_e2b_leases(key TEXT PRIMARY KEY,owner TEXT NOT NULL,expiresAt INTEGER NOT NULL);`);
  }
  e2bBinding(key: string): E2BComputerBinding | undefined {
    const row = this.db
      .prepare('SELECT value FROM computer_e2b_bindings WHERE key=?')
      .get(key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  /** SQLite coordinates API and agent hosts, including separate server processes. */
  async withE2bLease<T>(
    key: string,
    work: (lease: ComputerLease) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const owner = randomUUID();
    const ttl = 60_000;
    const deadline = Date.now() + 70_000;
    for (;;) {
      signal?.throwIfAborted();
      const now = Date.now();
      const result = this.db
        .prepare(
          `INSERT INTO computer_e2b_leases VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expiresAt=excluded.expiresAt
        WHERE computer_e2b_leases.expiresAt<=?`,
        )
        .run(key, owner, now + ttl, now);
      if (result.changes) break;
      if (now >= deadline)
        throw new Error(
          'Computer is busy with another lifecycle operation. Retry shortly.',
        );
      await delay(100, undefined, { signal });
    }
    const cancellation = new AbortController();
    const active = signal
      ? AbortSignal.any([signal, cancellation.signal])
      : cancellation.signal;
    const check = () => {
      active.throwIfAborted();
      const row = this.db
        .prepare('SELECT owner,expiresAt FROM computer_e2b_leases WHERE key=?')
        .get(key);
      if (row?.owner !== owner || Number(row.expiresAt) <= Date.now()) {
        cancellation.abort();
        throw new Error(
          'Computer lifecycle lease was lost. Retry the operation.',
        );
      }
    };
    const heartbeat = setInterval(() => {
      try {
        check();
        this.db
          .prepare(
            'UPDATE computer_e2b_leases SET expiresAt=? WHERE key=? AND owner=?',
          )
          .run(Date.now() + ttl, key, owner);
      } catch {
        cancellation.abort();
      }
    }, ttl / 3);
    try {
      return await work({
        signal: active,
        check,
        save: (binding) => {
          check();
          const saved = this.db
            .prepare(
              `INSERT INTO computer_e2b_bindings
          SELECT ?,? WHERE EXISTS (SELECT 1 FROM computer_e2b_leases WHERE key=? AND owner=? AND expiresAt>?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
            )
            .run(key, JSON.stringify(binding), key, owner, Date.now());
          if (!saved.changes)
            throw new Error(
              'Computer lifecycle lease was lost. Retry the operation.',
            );
        },
      });
    } finally {
      clearInterval(heartbeat);
      this.db
        .prepare('DELETE FROM computer_e2b_leases WHERE key=? AND owner=?')
        .run(key, owner);
    }
  }
  permissions(id: string): ComputerPermissions {
    const row = this.db
      .prepare('SELECT value FROM computer_permissions WHERE dotId=?')
      .get(id);
    return row
      ? JSON.parse(String(row.value))
      : { enabled: false, browser: false, files: false, shell: false };
  }
  patch(id: string, patch: Partial<ComputerPermissions>) {
    const value = { ...this.permissions(id), ...patch };
    this.db
      .prepare('INSERT OR REPLACE INTO computer_permissions VALUES (?,?)')
      .run(id, JSON.stringify(value));
    return value;
  }
  begin(dotId: string, action: string, actor: 'owner' | 'agent') {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO computer_audit VALUES (?,?,?,?,?,?)')
      .run(id, dotId, action, actor, 'pending', Date.now());
    return id;
  }
  finish(id: string, outcome: 'succeeded' | 'failed') {
    this.db
      .prepare('UPDATE computer_audit SET outcome=? WHERE id=?')
      .run(outcome, id);
    this.db
      .prepare(
        `DELETE FROM computer_audit WHERE dotId=(SELECT dotId FROM computer_audit WHERE id=?) AND outcome!='pending' AND id NOT IN (SELECT id FROM computer_audit WHERE dotId=(SELECT dotId FROM computer_audit WHERE id=?) AND outcome!='pending' ORDER BY createdAt DESC,rowid DESC LIMIT 1000)`,
      )
      .run(id, id);
  }
  audit(id: string): ComputerAudit[] {
    return this.db
      .prepare(
        'SELECT id,action,actor,outcome,createdAt FROM computer_audit WHERE dotId=? ORDER BY createdAt DESC LIMIT 50',
      )
      .all(id) as unknown as ComputerAudit[];
  }
}
