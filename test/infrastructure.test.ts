import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App, CliCredentialsStackSynthesizer } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ContactStack } from '../infra/contact-stack';
import { SetupStack } from '../infra/setup-stack';
import { ManualAssetsStack } from '../infra/manual-assets-stack';
import { manualAssetsBucketName } from '../infra/deployment-synthesizer';

const env = { account: '123456789012', region: 'us-east-1' };
const template = Template.fromStack(new ContactStack(new App(), 'Contact-test', { env, allowedOrigins: ['https://example.com'] }));

test('emails are required NoEcho parameters and never output', () => {
  for (const key of ['SenderEmail', 'RecipientEmail', 'AlertEmail']) {
    template.hasParameter(key, { Type: 'String', NoEcho: true });
    assert.equal(template.toJSON().Parameters[key].Default, undefined);
  }
  const outputs = JSON.stringify(template.toJSON().Outputs);
  assert.equal(outputs.includes('Email'), false);
});

test('Lambda uses account concurrency, a short timeout, and parameterized addresses', () => {
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs24.x', Architectures: ['arm64'], MemorySize: 128, Timeout: 8,
    ReservedConcurrentExecutions: Match.absent(),
    Environment: { Variables: {
      SENDER_EMAIL: { Ref: 'SenderEmail' }, RECIPIENT_EMAIL: { Ref: 'RecipientEmail' }, ALLOWED_ORIGINS: 'https://example.com',
    } },
  });
  assert.equal(template.toJSON().Parameters.ReservedConcurrency, undefined);
});

test('execution policy restricts SES action, sender identity, from address, and every recipient', () => {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
      Action: 'ses:SendEmail', Effect: 'Allow',
      Resource: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ses:us-east-1:123456789012:identity/', { Ref: 'SenderEmail' }]] },
      Condition: {
        StringEquals: { 'ses:FromAddress': { Ref: 'SenderEmail' } },
        'ForAllValues:StringEquals': { 'ses:Recipients': [{ Ref: 'RecipientEmail' }] },
        Null: { 'ses:Recipients': 'false' },
      },
    })]) },
  });
  const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
  assert.equal(policies.includes('ses:SendRawEmail'), false);
  assert.equal(policies.includes('secretsmanager:GetSecretValue'), false);
  template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  template.resourceCountIs('AWS::IAM::Role', 1);
});

test('HTTP API exposes one contact route with explicit CORS and a shared token bucket', () => {
  template.resourceCountIs('AWS::ApiGatewayV2::Route', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /contact', AuthorizationType: 'NONE' });
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    ProtocolType: 'HTTP', CorsConfiguration: {
      AllowOrigins: ['https://example.com'], AllowMethods: ['POST'], AllowHeaders: ['content-type'], AllowCredentials: false, MaxAge: 3600,
    },
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
    DefaultRouteSettings: { ThrottlingRateLimit: { Ref: 'ThrottleRate' }, ThrottlingBurstLimit: { Ref: 'ThrottleBurst' } },
    AccessLogSettings: Match.absent(),
  });
  template.hasResourceProperties('AWS::Lambda::Permission', { Principal: 'apigateway.amazonaws.com', SourceArn: Match.anyValue() });
  template.hasParameter('ThrottleRate', { Type: 'Number', Default: 0.1, MinValue: 0.01, MaxValue: 10 });
  template.hasParameter('ThrottleBurst', { Type: 'Number', Default: 2, MinValue: 1, MaxValue: 20 });
});

test('monitoring includes delivery failures, traffic, errors, throttles, and a cost budget', () => {
  template.resourceCountIs('AWS::CloudWatch::Alarm', 5);
  template.hasResourceProperties('AWS::Logs::MetricFilter', { FilterPattern: '{ $.event = "delivery_failed" }' });
  template.hasResourceProperties('AWS::Budgets::Budget', {
    Budget: { BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: { Ref: 'MonthlyBudgetUsd' }, Unit: 'USD' } },
    NotificationsWithSubscribers: Match.arrayWith([Match.objectLike({
      Subscribers: [{ Address: { Ref: 'AlertEmail' }, SubscriptionType: 'EMAIL' }],
    })]),
  });
  template.hasResourceProperties('AWS::SNS::TopicPolicy', { PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
    Principal: { Service: 'cloudwatch.amazonaws.com' }, Action: 'sns:Publish',
    Condition: { StringEquals: { 'aws:SourceAccount': '123456789012' }, ArnEquals: { 'aws:SourceArn': Match.anyValue() } },
  })]) } });
});

test('CI configuration keeps private values in AWS and pins one version throughout all resources', () => {
  const version = '00000000-0000-0000-0000-000000000000';
  const secretTemplate = Template.fromStack(new ContactStack(new App(), 'Contact-private', {
    env, allowedOrigins: ['https://example.com'], configSecret: { name: 'contact/prod/email', version },
  }));
  const recipient = `{{resolve:secretsmanager:contact/prod/email:SecretString:recipientEmail::${version}}}`;
  const sender = `{{resolve:secretsmanager:contact/prod/email:SecretString:senderEmail::${version}}}`;
  secretTemplate.hasResourceProperties('AWS::Lambda::Function', {
    Environment: { Variables: { SENDER_EMAIL: sender, RECIPIENT_EMAIL: recipient, ALLOWED_ORIGINS: 'https://example.com' } },
  });
  secretTemplate.hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
    Action: 'ses:SendEmail',
    Condition: { StringEquals: { 'ses:FromAddress': sender }, 'ForAllValues:StringEquals': { 'ses:Recipients': [recipient] } },
  })]) } });
  assert.equal(JSON.stringify(secretTemplate.toJSON().Outputs).includes('secretsmanager'), false);
  assert.equal(secretTemplate.toJSON().Parameters.RecipientEmail, undefined);
});

const setupProps = {
  env, deploymentEnvironment: 'prod', repository: 'owner/repository',
  oidcSubject: 'repo:owner/repository:environment:production', existingOidcProvider: false, qualifier: 'hnb659fds',
};
test('manual deployment needs only a private asset bucket and never assumes deployment roles', () => {
  const app = new App();
  const assets = new ManualAssetsStack(app, 'ManualAssets', { env, deploymentEnvironment: 'test' });
  const setup = new SetupStack(app, 'ManualDeploymentSetup', {
    env, deploymentEnvironment: 'test', qualifier: 'hnb659fds', enableGitHubOidc: false,
    synthesizer: new CliCredentialsStackSynthesizer({ fileAssetsBucketName: manualAssetsBucketName('test') }),
  });
  const assetTemplate = Template.fromStack(assets);
  assetTemplate.resourceCountIs('AWS::S3::Bucket', 1);
  assetTemplate.resourceCountIs('AWS::IAM::Role', 0);
  assetTemplate.resourceCountIs('AWS::IAM::Policy', 0);
  assetTemplate.hasResourceProperties('AWS::S3::Bucket', {
    BucketName: 'contact-assets-123456789012-us-east-1-test',
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    },
    BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
  });
  assetTemplate.hasResourceProperties('AWS::S3::BucketPolicy', { PolicyDocument: { Statement: Match.arrayWith([
    Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
  ]) } });
  const assembly = app.synth();
  for (const stack of [assets, setup]) {
    const artifact = assembly.getStackArtifact(stack.artifactId);
    assert.equal(artifact.assumeRoleArn, undefined);
    assert.equal(artifact.cloudFormationExecutionRoleArn, undefined);
    assert.equal(artifact.requiresBootstrapStackVersion, undefined);
  }
});
test('manual setup provisions only configuration, without GitHub permissions or OIDC', () => {
  const setup = Template.fromStack(new SetupStack(new App(), 'ManualSetup', {
    env, deploymentEnvironment: 'prod', qualifier: 'hnb659fds', enableGitHubOidc: false,
  }));
  setup.resourceCountIs('AWS::SecretsManager::Secret', 1);
  setup.resourceCountIs('AWS::IAM::Role', 0);
  setup.resourceCountIs('AWS::IAM::Policy', 0);
  setup.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  setup.resourceCountIs('AWS::Lambda::Function', 0);
  setup.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'contact/prod/email', SecretString: Match.absent() });
  assert.equal(setup.toJSON().Outputs.GitHubRoleArn, undefined);
});
test('setup scopes OIDC trust to the exact audience, repository, and production environment', () => {
  const setup = Template.fromStack(new SetupStack(new App(), 'Setup', setupProps));
  setup.hasResourceProperties('AWS::IAM::Role', { AssumeRolePolicyDocument: { Statement: [{
    Action: 'sts:AssumeRoleWithWebIdentity', Effect: 'Allow', Principal: { Federated: Match.anyValue() },
    Condition: { StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': setupProps.oidcSubject,
    } },
  }] } });
  setup.resourceCountIs('AWS::IAM::OIDCProvider', 1);
  setup.resourceCountIs('AWS::Lambda::Function', 0);
  setup.hasResourceProperties('AWS::SecretsManager::Secret', { Name: 'contact/prod/email', SecretString: Match.absent() });
  const policy = JSON.stringify(setup.findResources('AWS::IAM::Policy'));
  assert.equal(policy.includes('AdministratorAccess'), false);
  assert.equal(policy.includes('GetSecretValue'), false);
});

test('supports immutable GitHub subjects and an existing OIDC provider', () => {
  const setup = Template.fromStack(new SetupStack(new App(), 'ImmutableSetup', {
    ...setupProps, oidcSubject: 'repo:owner@123/repository@456:environment:production', existingOidcProvider: true,
  }));
  setup.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  assert.ok(JSON.stringify(setup.toJSON()).includes('repo:owner@123/repository@456:environment:production'));
});

for (const subject of ['repo:owner/*:environment:production', 'repo:owner/repository:ref:refs/heads/main',
  'repo:other/repository:environment:production', 'repo:owner/repository:environment:staging']) {
  test(`rejects unsafe OIDC subject ${subject}`, () => {
    assert.throws(() => new SetupStack(new App(), 'BadSetup', { ...setupProps, oidcSubject: subject }));
  });
}
