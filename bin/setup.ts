import { App } from 'aws-cdk-lib';
import { SetupStack } from '../infra/setup-stack';
import { deploymentSynthesizer } from '../infra/deployment-synthesizer';

const repository = process.env.GITHUB_REPOSITORY ?? '';
const setupMode = process.env.SETUP_MODE ?? 'github';
if (setupMode !== 'manual' && setupMode !== 'github') throw new Error('SETUP_MODE must be manual or github');
if (setupMode === 'github' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('Set GITHUB_REPOSITORY=OWNER/REPOSITORY');
}
const deploymentEnvironment = process.env.DEPLOY_ENV ?? 'prod';
if (!/^[a-z][a-z0-9-]{0,19}$/.test(deploymentEnvironment)) throw new Error('Invalid DEPLOY_ENV');
const qualifier = process.env.CDK_QUALIFIER ?? 'hnb659fds';
if (!/^[a-zA-Z0-9]{1,10}$/.test(qualifier)) throw new Error('Invalid CDK_QUALIFIER');
new SetupStack(new App(), `ContactSetup-${deploymentEnvironment}`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION },
  synthesizer: deploymentSynthesizer(deploymentEnvironment, qualifier),
  deploymentEnvironment,
  enableGitHubOidc: setupMode === 'github',
  repository,
  oidcSubject: process.env.GITHUB_OIDC_SUBJECT ?? '',
  existingOidcProvider: process.env.EXISTING_GITHUB_OIDC_PROVIDER === 'true',
  qualifier,
});
