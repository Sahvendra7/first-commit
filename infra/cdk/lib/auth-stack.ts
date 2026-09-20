/**
 * `auth-stack` — architecture.md §10.2.
 *
 * Cognito user pool, hosted UI, unthemed. The skill is explicit: "Do not spend
 * time on it." §10.2 is equally explicit about why there is nothing to build —
 * "No custom auth. No password handling in application code — ever." The
 * application never sees a credential; it sees a verified `sub` claim.
 */
import { CfnOutput, Duration, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib';
import { AccountRecovery, OAuthScope, UserPool, UserPoolClient } from 'aws-cdk-lib/aws-cognito';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export class AuthStack extends Stack {
  readonly userPool: UserPool;
  readonly userPoolClient: UserPoolClient;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.userPool = new UserPool(this, 'HandoverUsers', {
      selfSignUpEnabled: true,
      // §10.2: "email + password with mandatory verification".
      signInAliases: { email: true },
      autoVerify: { email: true },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      standardAttributes: { email: { required: true, mutable: false } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('WebClient', {
      authFlows: { userSrp: true },
      // §10.2: ID token in memory, refresh handled by Cognito. Short-lived
      // access tokens are what make "no tokens in localStorage" survivable.
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      oAuth: { scopes: [OAuthScope.OPENID, OAuthScope.EMAIL] },
      preventUserExistenceErrors: true,
    });

    Tags.of(this).add('handover:stack', 'auth');

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}
