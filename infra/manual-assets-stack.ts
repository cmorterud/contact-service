import { LegacyStackSynthesizer, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class ManualAssetsStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { deploymentEnvironment: string }) {
    // This small stack has no file assets, so it can deploy before an asset bucket exists.
    super(scope, id, { ...props, synthesizer: new LegacyStackSynthesizer() });
    new Bucket(this, 'Assets', {
      bucketName: `contact-assets-${this.account}-${this.region}-${props.deploymentEnvironment}`,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
