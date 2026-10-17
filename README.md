# Serverless contact service

A small TypeScript service: `POST /contact` → API Gateway HTTP API → Lambda → Amazon SES. There is no database, frontend, authentication, CAPTCHA, WAF, attachment support, or message queue. Node.js 24, the AWS SDK v3, and CDK v2 are used. One deployment can serve several websites through its origin allowlist.

## API

```http
POST /contact
Content-Type: application/json
Origin: https://example.com

{"message":"Hello from the website","replyEmail":"visitor@example.com"}
```

`message` is required. After NFC Unicode normalization, line-ending normalization, and trimming, it must contain 1–2,000 Unicode code points. Newlines and tabs are allowed; unsafe control characters, bidirectional formatting controls, and unpaired surrogates are rejected. Email is sent as UTF-8 plain text, so markup is literal text. `replyEmail` is optional; omit it rather than passing an empty string or `null`. Mailboxes must be ASCII addresses without display names. CR/LF are rejected before email trimming. The visitor address is used only as `Reply-To`; the sender and destination always come from deployment configuration.

The JSON object may contain **only** these two fields. Recipient, subject, sender, CC, and BCC cannot be supplied by a caller. The request body is limited to **16 KiB of decoded UTF-8 bytes**, including the JSON envelope. JSON and base64 payloads are checked before parsing; compression is unsupported. Highly escaped JSON may exceed the byte limit even with a valid message length.

| Status | Meaning |
| --- | --- |
| `200` | SES accepted the email; `{"message":"Message accepted."}` |
| `400` | Invalid JSON, message, email, or unknown property |
| `403` | An Origin header was supplied but is outside the allowlist |
| `404` | Route or method does not exist |
| `413` | Body exceeds the application limit |
| `415` | Unsupported content type or content encoding |
| `503` | Configuration or delivery failure; generic response |

API Gateway can also return `429` when throttled and its own generic `4xx`/`5xx` responses before Lambda runs. Lambda concurrency exhaustion can surface as a gateway `5xx`. Gateway-generated bodies can differ from the application's JSON messages. Responses never include addresses, submitted text, SES IDs, or SDK errors. `200` does not guarantee inbox delivery. There are no automatic SES retries, and no persistence or deduplication; a network failure after SES accepts a message may produce `503` even though the email was sent. Repeated submissions can send duplicates.

## Local checks

Install Node.js 24 and npm. No AWS credentials are needed for these checks:

```sh
npm ci
npm run check
npm run synth
```

Tests cover validation, headers, body size/encoding, successful and failed sends, response/log privacy, and infrastructure permissions and controls. The SDK is mocked; tests do not send mail. CDK bundles the pinned SES SDK with esbuild. `synth` uses `https://example.invalid` as a fail-closed origin placeholder when no list is provided; the deployment script requires an explicit list.

The files under `src/` are the handler and input validation. `infra/contact-stack.ts` owns the service and monitoring; `infra/setup-stack.ts` owns the AWS-side configuration container and GitHub federation. `scripts/deploy.ts` deploys with configuration references without reading private values.

## First deployment

### 1. Prepare the AWS account and CDK bootstrap

Choose an AWS account and Region that support SES. Use a short-lived local AWS session (for example, AWS IAM Identity Center / SSO), never committed keys. The initial operator needs permissions to bootstrap CDK and create IAM, SES, API Gateway, Lambda, CloudWatch, SNS, Secrets Manager, and Budgets resources. Billing/Budgets permissions may need separate account-owner setup. Lambda reserved concurrency also requires sufficient account quota and unreserved capacity; small/new accounts may need a quota increase.

Export public settings locally; `.env.example` documents all settings but is not loaded automatically:

```sh
export AWS_REGION=us-east-1
export CDK_DEFAULT_ACCOUNT=123456789012
export DEPLOY_ENV=prod
export CDK_QUALIFIER=hnb659fds
export GITHUB_REPOSITORY=OWNER/REPOSITORY
export GITHUB_OIDC_SUBJECT='repo:OWNER/REPOSITORY:environment:production'
export ALLOWED_ORIGINS='https://example.com,https://www.example.com'

npm run cdk -- bootstrap "aws://$CDK_DEFAULT_ACCOUNT/$AWS_REGION" --qualifier "$CDK_QUALIFIER"
```

Use the **exact** subject format emitted by your repository. GitHub repositories using immutable subjects include owner/repository numeric IDs, for example `repo:OWNER@123/REPOSITORY@456:environment:production`. Older repositories can use the name-only format above. Check your repository/organization OIDC settings; the setup stack accepts either format, but trusts only the one you supply. It rejects wildcards, other repositories, and environments other than `production`. [GitHub documents the subject formats](https://docs.github.com/en/actions/reference/security/oidc).

The standard CDK bootstrap uses a powerful CloudFormation execution role (AdministratorAccess by default). The GitHub role can assume only the exact bootstrap deployment, file-publishing, and lookup roles for this account/Region/qualifier, but these still represent privileged deployment access. Use a dedicated AWS account for strong isolation. Organizations can bootstrap with their own execution policy and permissions boundary; that policy must include the resources above and `secretsmanager:GetSecretValue` on `contact/prod/email` so **CloudFormation** can resolve the private configuration. The GitHub and Lambda roles do not get `GetSecretValue` permissions.

### 2. Provision configuration and GitHub OIDC

If the account already has the `token.actions.githubusercontent.com` IAM OIDC provider, set `EXISTING_GITHUB_OIDC_PROVIDER=true`. Otherwise this stack creates it natively through CloudFormation. An imported provider must include `sts.amazonaws.com` in its client ID list. Only one provider with this URL can exist per account; import it when setting up additional environments.

```sh
npm run cdk -- --app 'node --import tsx bin/setup.ts' diff "ContactSetup-$DEPLOY_ENV"
npm run cdk -- --app 'node --import tsx bin/setup.ts' deploy "ContactSetup-$DEPLOY_ENV"
```

Record the `GitHubRoleArn` output. This stack also creates an **empty** secret named `contact/prod/email`; its private values are not part of the template. In the AWS Secrets Manager console, set a plaintext JSON value with the following keys (replace these placeholders **in AWS**, never in this repository or GitHub):

```json
{
  "senderEmail": "sender@example.com",
  "recipientEmail": "recipient@example.com",
  "alertEmail": "alerts@example.com"
}
```

Use bare, valid ASCII mailboxes. Save the value, then copy its **version ID** from the secret's version list. Keep that version available for rollback. The version ID is a public deployment identifier; the secret contents are private.

With `CONFIG_VERSION` set, CDK emits version-pinned Secrets Manager dynamic references directly in the resource properties; AWS resolves them into the Lambda environment, SES policy, and alert resources. No private values are downloaded to GitHub, written into source/templates, or placed in deployment command arguments. There is no recipient output. [CloudFormation documents dynamic-reference behavior and limitations](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references-secretsmanager.html).

For operators who already inject private configuration directly into CloudFormation, omitting `CONFIG_VERSION` exposes required **NoEcho deployment parameters** named `SenderEmail`, `RecipientEmail`, and `AlertEmail`. This mode supports alternative private deployment tooling; the included GitHub workflow and deployment script always use AWS-side secret references. Never synthesize actual addresses into the template or pass them through GitHub.

Addresses do exist in private AWS resource configuration (for example, Lambda environment variables and IAM conditions) and in the delivered email. Restrict access to those resources and the mailbox. Do not publish AWS console screenshots, configuration exports, or resolved resource policies. `NoEcho` is not a replacement for AWS access control. Keep `.env`, credentials, and `cdk.out` out of Git; `.gitignore` covers these files. No request, access, or SES event logging containing personal information is enabled by this project.

### 3. Configure GitHub production protections

Create a GitHub Environment named **`production`**. Under its deployment branch/tag rules, select only the branch **`main`** and allow no tags. This is required: GitHub's environment subject replaces the branch in the OIDC subject, so IAM's environment trust alone does not enforce `main`. Protect `main` with reviewed changes; restrict workflow edits with repository review rules. Required reviewers on the environment are useful when available.

Set these **Environment variables**, not secrets:

| Variable | Value |
| --- | --- |
| `AWS_REGION` | Target Region |
| `AWS_ACCOUNT_ID` | Target account ID |
| `AWS_DEPLOY_ROLE_ARN` | `GitHubRoleArn` from setup |
| `ALLOWED_ORIGINS` | Comma-separated exact HTTPS origins, with no trailing slashes |
| `CONFIG_VERSION` | Version ID of the populated AWS secret |
| `CDK_QUALIFIER` | Optional; defaults to `hnb659fds` |

The numeric tuning variables in `.env.example` are optional. Do **not** put email addresses, the secret's JSON, access keys, or session credentials in GitHub variables, secrets, workflow inputs, or repository files. GitHub obtains temporary AWS credentials through OIDC. [GitHub's AWS OIDC guide](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws) explains the trust and environment protections.

### 4. Deploy and verify SES

Push this project to `main`, then open **Actions → Deploy production → Run workflow**, selecting `main`. There is no push, pull-request, or scheduled deployment trigger. The job also checks `main`, uses the protected `production` environment, runs tests and synthesis, prints an infrastructure diff, and deploys. Actions are pinned to commit SHAs; Dependabot proposes dependency and Action updates. Review those changes before merging.

The service stack provisions an SES identity for the **exact configured sender email**. Follow the verification link SES sends to that mailbox. If that exact identity already exists in this account/Region, import it into CloudFormation/CDK or replace the `EmailIdentity` creation with `EmailIdentity.fromEmailIdentityName` before deploying; do not attempt duplicate ownership. A verified domain identity can also be used by adapting the identity and its IAM ARN together. Keep the `ses:FromAddress` condition pinned to the configured sender.

SES verification and sandbox status are **Region-specific**. While in the SES sandbox, verify the recipient identity through SES as well (or a domain covering it); sending rate and daily quotas are restricted. For general production sending, request production access for this Region. Sender verification is still required after sandbox exit. The visitor's Reply-To address does not need verification because no email is sent to it. [SES sandbox guidance](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) and [identity verification guidance](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html) describe the manual ownership steps.

Confirm the SNS subscription sent to `alertEmail`, then check that the expected budget notifications exist in AWS Budgets. Mail delivery can return `503` until SES setup is complete. Use the `ContactUrl` stack output to send one synthetic test:

```sh
curl -i 'https://API_ID.execute-api.REGION.amazonaws.com/contact' \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://example.com' \
  --data '{"message":"Deployment test"}'
```

Confirm `200` and inbox receipt. Also try malformed JSON, a disallowed origin, and a recipient field; confirm rejection without mail. Avoid aggressive load tests against a real recipient.

For a local operator deployment with the same AWS-side configuration:

```sh
export CONFIG_VERSION=YOUR_AWS_SECRET_VERSION_ID
npm run check
npm run cdk -- diff "Contact-$DEPLOY_ENV" --method template --fail-on never
npm run deploy
```

The script requires an explicit version and origins, and uses argument arrays without shell interpolation. Review code and the diff before dispatching/deploying. Template diffs show secret reference/version changes but not the private values, and do not show parameter-only tuning changes; review the public settings and selected secret version in AWS too.

## Controls, monitoring, and cost

- SES access is only `ses:SendEmail`, scoped to the sender identity ARN, exact `ses:FromAddress`, and **all** destination addresses matching the configured recipient. A `Null` check requires the recipient condition key. There is no raw-email permission or request-selected destination. [SES IAM documentation](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html) describes these conditions.
- API Gateway defaults to **0.1 requests/second**, burst **2**, across this deployment. Lambda has reserved concurrency **2**, 128 MiB ARM64 memory, and an 8-second timeout; the SDK has a shorter send deadline and one attempt. Throttling, concurrency, and the monthly budget are deployment parameters; their environment-variable counterparts are in `.env.example`. All websites sharing a deployment share its limits.
- CORS permits only configured HTTPS origins and JSON POSTs. Lambda also rejects a supplied disallowed Origin. **CORS is a browser policy, not authentication**: non-browser clients can omit or forge Origin. There is no per-IP quota, CAPTCHA, or durable deduplication under this design.
- HTTP API throttles are [best-effort targets](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html), not hard spending or email caps. The 16 KiB limit is enforced inside Lambda; oversized traffic can still incur API/Lambda charges before rejection. Reserved concurrency limits in-flight work, not total daily sends. This provides modest protection suitable for a low-volume public contact form; a determined sender can still consume capacity and send unwanted submissions.
- Application errors emit only the fixed `delivery_failed` marker. There is no request/message/email/IP logging and no API access log. Logs expire after seven days. Standard Lambda platform logs contain operational metadata. Avoid enabling SES event destinations, CloudTrail SES data events, or request/debug logging without first assessing their personal-data exposure.
- Five CloudWatch alarms monitor delivery-failure markers, Lambda errors, Lambda throttles, API `5xx`, and at least 100 API requests in five minutes. They notify the SNS email subscriber. An account-wide monthly cost budget defaults to **USD 5** and emails at 80% and 100%; it includes other workloads in this AWS account. Budget data and notifications can be delayed and do **not** stop spending.
- HTTP API, Lambda, and SES incur usage charges. Secrets Manager, the custom metric, CloudWatch alarms, logs, and SNS can add baseline charges even with little traffic. There is no VPC or NAT gateway. Check current [AWS pricing](https://aws.amazon.com/pricing/) for your Region; no free-tier availability or zero-cost operation is assumed.

To stop mail quickly during an incident, set the function's reserved concurrency to **0** in the Lambda console. API Gateway may still charge for incoming traffic; remove its route or delete the service stack to retire the endpoint. Restore the configured concurrency through CDK after investigating. Disabling reserved concurrency this way creates temporary drift; redeploy and verify the actual value before reopening traffic.

## Other environments and configuration changes

Use a distinct `DEPLOY_ENV` (for example `staging`) to create `Contact-staging`, `ContactSetup-staging`, and `contact/staging/email`, with independent addresses, allowed origins, limits, and secret versions. Local deployments support this directly. The included GitHub workflow deliberately deploys **only `prod`**, and its IAM trust uses the `production` GitHub Environment. For separate GitHub environments, add separate roles with exact corresponding subjects and matching protection rules before adding workflows. If two stacks in one AWS account/Region use the same exact sender identity, import/share that identity instead of creating it twice.

To change addresses, save a new secret version in AWS, update `CONFIG_VERSION`, and redeploy. Pinning the new version updates both the Lambda configuration and IAM restrictions together; editing a secret alone does not update existing resources. A sender change requires new SES verification. An alert address change requires confirming its new SNS subscription. Keep the prior version through the rollback window; never delete a version still referenced by a stack. Reuse across more websites by extending `ALLOWED_ORIGINS` and redeploying; use separate deployments when recipients must differ.

For teardown, use `npm run cdk -- destroy "Contact-$DEPLOY_ENV"` and, when its GitHub role/provider are no longer needed, destroy the setup stack with the setup app. The configuration secret is retained deliberately; delete it separately in Secrets Manager after the recovery window. Do not remove a shared GitHub OIDC provider or the shared CDK bootstrap stack while other deployments depend on them.
