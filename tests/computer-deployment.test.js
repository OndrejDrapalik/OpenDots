import { expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import console from 'node:console';
import { Template } from 'e2b';
import {
  buildComputerTemplate,
  computerTemplateDefinition,
} from '../deployment/computers/e2b/build-template.mjs';
import { hardenSupervisorEnvironment } from '../deployment/computers/harden-supervisor.mjs';

const upstream = `export function environmentFor(botId, env) {
  const computerToken = env.COMPUTER_TOKEN?.trim() || undefined;
  return [\`COMPUTER_BOT_ID=\${botId}\`, \`COMPUTER_TOKEN=\${computerToken}\`];
}`;
it('gives each child its own credential without forwarding the master', async () => {
  const module = await import(
    `data:text/javascript,${encodeURIComponent(hardenSupervisorEnvironment(upstream))}`
  );
  const master = 'fixture-master-only-for-this-test';
  const first = module.environmentFor('dot-a', { COMPUTER_TOKEN: master });
  const second = module.environmentFor('dot-b', { COMPUTER_TOKEN: master });
  expect(first[1]).toBe(
    `COMPUTER_TOKEN=${createHmac('sha256', master).update('opendots-computer:dot-a').digest('hex')}`,
  );
  expect(first[1]).not.toBe(second[1]);
  expect(first.join()).not.toContain(master);
  expect(() =>
    module.environmentFor('dot-a', { COMPUTER_TOKEN: 'short' }),
  ).toThrow();
});
it('refuses missing or ambiguous upstream patch targets', () => {
  expect(() => hardenSupervisorEnvironment('changed upstream')).toThrow(
    /contract changed/,
  );
  expect(() => hardenSupervisorEnvironment(upstream + upstream)).toThrow(
    /contract changed/,
  );
});
it('builds a frozen, licensed computer release matching the supervisor source pin', async () => {
  const { release, dockerfile, template } = computerTemplateDefinition();
  const compose = readFileSync(
    new URL('../compose.computers.yml', import.meta.url),
    'utf8',
  );
  const revisions = [...compose.matchAll(/OpenBot\.git#([a-f0-9]{40})/g)].map(
    (match) => match[1],
  );
  expect(revisions).toEqual([release.openbotRevision, release.openbotRevision]);
  expect(dockerfile).toContain(
    `ARG OPENBOT_REVISION=${release.openbotRevision}`,
  );
  expect(dockerfile).toContain(`ARG NODE_VERSION=${release.nodeVersion}`);
  expect(dockerfile).toContain(`ARG BUN_VERSION=${release.bunVersion}`);
  const definition = JSON.parse(await template.toJSON(true));
  expect(JSON.stringify(definition)).toContain('bun install --frozen-lockfile');
  expect(definition.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'ENV',
        args: ['PLAYWRIGHT_BROWSERS_PATH', '/ms-playwright'],
      }),
      expect.objectContaining({
        type: 'ENV',
        args: [
          'PATH',
          '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        ],
      }),
    ]),
  );
  expect(JSON.stringify(definition)).toContain('/app/LICENSE.openbot');
  expect(JSON.stringify(definition)).toContain('procps');
  expect(dockerfile).not.toContain("--exclude='*/LICENSE'");
});
it('uses the installed SDK to build tagged templates without requiring a global CLI', async () => {
  const result = { buildId: 'fixture-build' };
  const build = vi.spyOn(Template, 'build').mockResolvedValue(result);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await expect(buildComputerTemplate({})).rejects.toThrow('Set E2B_API_KEY');
    expect(build).not.toHaveBeenCalled();
    expect(
      await buildComputerTemplate({
        E2B_API_KEY: ' fixture-key ',
        E2B_DOMAIN: 'e2b.example',
        COMPUTER_E2B_TEMPLATE: 'team/computer:v1',
      }),
    ).toBe(result);
    expect(build).toHaveBeenCalledWith(
      expect.anything(),
      'team/computer:v1',
      expect.objectContaining({
        apiKey: 'fixture-key',
        domain: 'e2b.example',
        cpuCount: 2,
        memoryMB: 2048,
      }),
    );
    expect(log.mock.calls.flat().join()).not.toContain('fixture-key');
  } finally {
    build.mockRestore();
    log.mockRestore();
  }
});
