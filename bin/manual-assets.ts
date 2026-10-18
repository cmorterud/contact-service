import { App } from 'aws-cdk-lib';
import { ManualAssetsStack } from '../infra/manual-assets-stack';

const deploymentEnvironment = process.env.DEPLOY_ENV ?? 'prod';
if (!/^[a-z][a-z0-9-]{0,19}$/.test(deploymentEnvironment)) throw new Error('Invalid DEPLOY_ENV');
new ManualAssetsStack(new App(), `ContactAssets-${deploymentEnvironment}`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION },
  deploymentEnvironment,
});
