import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

interface SetupStackProps extends StackProps {
  readonly deploymentEnvironment: string;
  readonly enableGitHubOidc?: boolean;
  readonly repository?: string;
  readonly oidcSubject?: string;
  readonly existingOidcProvider?: boolean;
  readonly qualifier: string;
}

export class SetupStack extends Stack {
  constructor(scope: Construct, id: string, props: SetupStackProps) {
    super(scope, id, props);
    const config = new secretsmanager.CfnSecret(this, 'PrivateConfiguration', {
      name: `contact/${props.deploymentEnvironment}/email`,
      description: 'Set JSON keys senderEmail, recipientEmail, alertEmail in AWS before deploying the contact stack.',
      // Create an empty secret with no private values in CloudFormation.
      // Populate its first version through the AWS console before deployment.
    });
    config.applyRemovalPolicy(RemovalPolicy.RETAIN);
    new CfnOutput(this, 'PrivateConfigurationName', { value: `contact/${props.deploymentEnvironment}/email` });
    if (props.enableGitHubOidc === false) return;

    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(props.repository ?? '')) {
      throw new Error('Set a GitHub repository for OIDC setup');
    }
    const [owner, repository] = (props.repository ?? '').split('/');
    const oidcSubject = props.oidcSubject ?? '';
    // Accept GitHub's legacy and immutable subject formats, always matching this
    // exact repository and production environment, with no trust wildcards.
    const legacy = `repo:${owner}/${repository}:environment:production`;
    const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const immutable = new RegExp(`^repo:${escapeRegex(owner ?? '')}@[0-9]+/${escapeRegex(repository ?? '')}@[0-9]+:environment:production$`);
    if (oidcSubject !== legacy && !immutable.test(oidcSubject)) {
      throw new Error('OIDC subject must match the configured repository and production environment exactly');
    }
    const provider = props.existingOidcProvider
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHubProvider',
        `arn:${this.partition}:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`)
      : new iam.OidcProviderNative(this, 'GitHubProvider', {
        url: 'https://token.actions.githubusercontent.com',
        clientIds: ['sts.amazonaws.com'],
      });
    const deployRole = new iam.Role(this, 'GitHubDeployRole', {
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': oidcSubject,
        },
      }),
    });
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: ['deploy', 'file-publishing', 'lookup'].map((kind) =>
        `arn:${this.partition}:iam::${this.account}:role/cdk-${props.qualifier}-${kind}-role-${this.account}-${this.region}`),
    }));
    deployRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: [this.formatArn({ service: 'cloudformation', resource: 'stack', resourceName: 'CDKToolkit/*' })],
    }));
    new CfnOutput(this, 'GitHubRoleArn', { value: deployRole.roleArn });
  }
}
