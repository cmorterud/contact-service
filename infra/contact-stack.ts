import * as path from 'node:path';
import { CfnDynamicReference, CfnDynamicReferenceService, CfnOutput, CfnParameter, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

interface ContactStackProps extends StackProps {
  readonly allowedOrigins: string[];
  readonly configSecret?: { readonly name: string; readonly version: string };
}

export class ContactStack extends Stack {
  constructor(scope: Construct, id: string, props: ContactStackProps) {
    super(scope, id, props);
    const email = (parameter: string, key: string): string => props.configSecret
      ? new CfnDynamicReference(CfnDynamicReferenceService.SECRETS_MANAGER,
        `${props.configSecret.name}:SecretString:${key}::${props.configSecret.version}`).toString()
      : new CfnParameter(this, parameter, { type: 'String', noEcho: true, minLength: 1 }).valueAsString;
    const sender = email('SenderEmail', 'senderEmail');
    const recipient = email('RecipientEmail', 'recipientEmail');
    const alert = email('AlertEmail', 'alertEmail');
    const rate = new CfnParameter(this, 'ThrottleRate', {
      type: 'Number', default: 0.1, minValue: 0.01, maxValue: 10,
      description: 'Shared POST /contact token refill rate in requests per second (0.1 = 6 per minute).',
    });
    const burst = new CfnParameter(this, 'ThrottleBurst', {
      type: 'Number', default: 2, minValue: 1, maxValue: 20,
      description: 'Shared POST /contact token bucket capacity. API Gateway throttling is best effort.',
    });
    const budgetAmount = new CfnParameter(this, 'MonthlyBudgetUsd', { type: 'Number', default: 5, minValue: 1, maxValue: 100 });

    // Verifies the exact sender mailbox. The owner must follow SES's email link.
    // Reuse an existing identity by importing it instead if the account owns it already.
    new ses.EmailIdentity(this, 'SenderIdentity', { identity: ses.Identity.email(sender) });

    const logGroup = new logs.LogGroup(this, 'FunctionLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(this, 'ContactExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [logGroup.logGroupArn],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: [this.formatArn({ service: 'ses', resource: 'identity', resourceName: sender })],
      conditions: {
        StringEquals: { 'ses:FromAddress': sender },
        'ForAllValues:StringEquals': { 'ses:Recipients': [recipient] },
        Null: { 'ses:Recipients': 'false' },
      },
    }));

    const handler = new NodejsFunction(this, 'ContactHandler', {
      entry: path.join(__dirname, '../src/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(8),
      role,
      logGroup,
      environment: {
        SENDER_EMAIL: sender,
        RECIPIENT_EMAIL: recipient,
        ALLOWED_ORIGINS: props.allowedOrigins.join(','),
      },
      bundling: {
        target: 'node24',
        minify: true,
        sourceMap: false,
        // Bundle the pinned SDK; do not rely on Lambda's changing bundled version.
        externalModules: [],
      },
    });

    const api = new apigateway.HttpApi(this, 'ContactApi', {
      createDefaultStage: false,
      corsPreflight: {
        allowOrigins: props.allowedOrigins,
        allowMethods: [apigateway.CorsHttpMethod.POST],
        allowHeaders: ['content-type'],
        allowCredentials: false,
        maxAge: Duration.hours(1),
      },
    });
    api.addRoutes({
      path: '/contact',
      methods: [apigateway.HttpMethod.POST],
      integration: new HttpLambdaIntegration('ContactIntegration', handler, { timeout: Duration.seconds(10) }),
    });
    new apigateway.HttpStage(this, 'DefaultStage', {
      httpApi: api,
      stageName: '$default',
      autoDeploy: true,
      // One route: this bucket is shared by all callers and allowed websites,
      // before Lambda invocation. These are best-effort targets, not hard caps.
      throttle: { rateLimit: rate.valueAsNumber, burstLimit: burst.valueAsNumber },
      // No access logs: default formats may include IP addresses and request paths.
    });

    const alerts = new sns.Topic(this, 'Alerts');
    alerts.addSubscription(new subscriptions.EmailSubscription(alert));
    const failureMetric = new logs.MetricFilter(this, 'DeliveryFailures', {
      logGroup,
      filterPattern: logs.FilterPattern.stringValue('$.event', '=', 'delivery_failed'),
      metricNamespace: 'ContactService',
      metricName: `${this.stackName}-DeliveryFailures`,
      metricValue: '1',
      defaultValue: 0,
    }).metric({ statistic: 'Sum', period: Duration.minutes(5) });
    const alarms: cloudwatch.Alarm[] = [];
    const alarm = (name: string, metric: cloudwatch.IMetric, threshold: number) => {
      const resource = new cloudwatch.Alarm(this, name, {
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      resource.addAlarmAction(new SnsAction(alerts));
      alarms.push(resource);
    };
    alarm('DeliveryFailureAlarm', failureMetric, 1);
    alarm('LambdaErrorAlarm', handler.metricErrors({ period: Duration.minutes(5) }), 1);
    alarm('LambdaThrottleAlarm', handler.metricThrottles({ period: Duration.minutes(5) }), 1);
    alarm('ApiServerErrorAlarm', api.metricServerError({ period: Duration.minutes(5), statistic: 'Sum' }), 1);
    alarm('TrafficAlarm', api.metricCount({ period: Duration.minutes(5), statistic: 'Sum' }), 100);
    alerts.addToResourcePolicy(new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [alerts.topicArn],
      conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnEquals: { 'aws:SourceArn': alarms.map((resource) => resource.alarmArn) },
      },
    }));

    // Account-wide budget catches untaggable API/SES spend too; not a spending cap.
    new budgets.CfnBudget(this, 'MonthlyCostBudget', {
      budget: {
        budgetName: `${this.stackName}-monthly-account-cost`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: budgetAmount.valueAsNumber, unit: 'USD' },
      },
      notificationsWithSubscribers: [80, 100].map((threshold) => ({
        notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
        subscribers: [{ address: alert, subscriptionType: 'EMAIL' }],
      })),
    });
    new CfnOutput(this, 'ContactUrl', { value: `${api.apiEndpoint}/contact` });
    new CfnOutput(this, 'FunctionName', { value: handler.functionName });
  }
}
