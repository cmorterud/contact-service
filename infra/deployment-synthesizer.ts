import { CliCredentialsStackSynthesizer, DefaultStackSynthesizer } from 'aws-cdk-lib';

export function manualAssetsBucketName(environment: string): string {
  return `contact-assets-\${AWS::AccountId}-\${AWS::Region}-${environment}`;
}

export function deploymentSynthesizer(environment: string, qualifier: string) {
  const mode = process.env.SETUP_MODE ?? 'github';
  if (mode !== 'manual' && mode !== 'github') throw new Error('SETUP_MODE must be manual or github');
  return mode === 'manual'
    ? new CliCredentialsStackSynthesizer({ fileAssetsBucketName: manualAssetsBucketName(environment) })
    : new DefaultStackSynthesizer({ qualifier });
}
