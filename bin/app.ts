import { App } from 'aws-cdk-lib';
import { ContactStack } from '../infra/contact-stack';
import { deploymentSynthesizer } from '../infra/deployment-synthesizer';
import { parseOrigins } from '../src/validation';

const environment = process.env.DEPLOY_ENV ?? 'prod';
if (!/^[a-z][a-z0-9-]{0,19}$/.test(environment)) throw new Error('Invalid DEPLOY_ENV');
const qualifier = process.env.CDK_QUALIFIER ?? 'hnb659fds';
if (!/^[a-zA-Z0-9]{1,10}$/.test(qualifier)) throw new Error('Invalid CDK_QUALIFIER');
const configVersion = process.env.CONFIG_VERSION;
if (configVersion !== undefined && !/^[A-Za-z0-9-]{32,64}$/.test(configVersion)) throw new Error('Invalid CONFIG_VERSION');
new ContactStack(new App(), `Contact-${environment}`, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION },
  synthesizer: deploymentSynthesizer(environment, qualifier),
  allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS ?? 'https://example.invalid'),
  ...(configVersion ? { configSecret: { name: `contact/${environment}/email`, version: configVersion } } : {}),
});
