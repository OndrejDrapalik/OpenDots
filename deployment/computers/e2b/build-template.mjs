import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Template, defaultBuildLogger } from 'e2b';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..');
export function computerTemplateDefinition() {
  const release = JSON.parse(
    readFileSync(resolve(directory, '../release.json'), 'utf8'),
  );
  if (
    !/^[a-f0-9]{40}$/.test(release.openbotRevision) ||
    !/^\d+\.\d+\.\d+$/.test(release.nodeVersion) ||
    !/^\d+\.\d+\.\d+$/.test(release.bunVersion)
  )
    throw new Error('Invalid computer release manifest.');
  let dockerfile = readFileSync(resolve(directory, 'e2b.Dockerfile'), 'utf8');
  for (const [name, value] of Object.entries({
    OPENBOT_REVISION: release.openbotRevision,
    NODE_VERSION: release.nodeVersion,
    BUN_VERSION: release.bunVersion,
  })) {
    const marker = `ARG ${name}\n`;
    if (dockerfile.split(marker).length !== 2)
      throw new Error(
        `Computer template must declare exactly one ${name} release argument.`,
      );
    dockerfile = dockerfile.replace(marker, `ARG ${name}=${value}\n`);
  }
  return {
    release,
    dockerfile,
    template: Template({ fileContextPath: root }).fromDockerfile(dockerfile),
  };
}
export async function buildComputerTemplate(env = process.env) {
  if (!env.E2B_API_KEY?.trim())
    throw new Error(
      'Set E2B_API_KEY in .env before building the computer template.',
    );
  const name = env.COMPUTER_E2B_TEMPLATE?.trim() || 'opendots-computer';
  if (
    name.length > 251 ||
    !/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)?(?::[A-Za-z0-9][A-Za-z0-9_.-]*)?$/.test(
      name,
    )
  )
    throw new Error('Invalid COMPUTER_E2B_TEMPLATE.');
  const { template } = computerTemplateDefinition();
  const result = await Template.build(template, name, {
    apiKey: env.E2B_API_KEY.trim(),
    ...(env.E2B_DOMAIN?.trim() ? { domain: env.E2B_DOMAIN.trim() } : {}),
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: defaultBuildLogger(),
  });
  console.log(
    `Built ${name}; immutable build ${result.buildId}. Existing computers upgrade on their next Start.`,
  );
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.includes('--check'))
    console.log(await computerTemplateDefinition().template.toJSON(true));
  else await buildComputerTemplate();
}
