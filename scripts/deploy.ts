import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { parseOrigins } from '../src/validation';

// Only public identifiers are handled here. CloudFormation resolves private
// addresses inside AWS; GitHub never downloads the Secrets Manager contents.
const environment = process.env.DEPLOY_ENV ?? 'prod';
if (!/^[a-z][a-z0-9-]{0,19}$/.test(environment)) throw new Error('Invalid DEPLOY_ENV');
const version = process.env.CONFIG_VERSION ?? '';
if (!/^[A-Za-z0-9-]{32,64}$/.test(version)) throw new Error('Set CONFIG_VERSION to the AWS secret version ID');
parseOrigins(process.env.ALLOWED_ORIGINS ?? '');
if (process.env.GITHUB_ACTIONS === 'true' &&
    (process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || environment !== 'prod')) {
  throw new Error('Production CI deployment requires manual dispatch from main');
}
const args = [
  'deploy', `Contact-${environment}`, '--require-approval', 'never',
];
for (const [parameter, variable] of [
  ['ThrottleRate', 'THROTTLE_RATE'], ['ThrottleBurst', 'THROTTLE_BURST'],
  ['ReservedConcurrency', 'RESERVED_CONCURRENCY'], ['MonthlyBudgetUsd', 'MONTHLY_BUDGET_USD'],
] as const) {
  const value = process.env[variable];
  if (value !== undefined) {
    if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`Invalid ${variable}`);
    args.push('--parameters', `${parameter}=${value}`);
  }
}
const cdk = path.join(__dirname, '../node_modules/aws-cdk/bin/cdk');
const result = spawnSync(process.execPath, [cdk, ...args], { stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
