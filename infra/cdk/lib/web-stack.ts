/**
 * `web-stack` — static hosting for `apps/web`.
 *
 * S3 behind CloudFront, chosen over Amplify Hosting because the account
 * already runs everything else through CDK: one deploy command, one place the
 * infrastructure is described, and no second console-managed pipeline to keep
 * in step with it.
 *
 * ── The bucket is never public ──────────────────────────────────────────────
 *
 * `S3BucketOrigin.withOriginAccessControl` signs CloudFront's reads with SigV4
 * and writes the matching bucket policy, so the only way to the objects is
 * through the distribution. `blockPublicAccess: BLOCK_ALL` then makes a future
 * "just make it public for a minute" a deploy failure rather than a quiet
 * exposure. This is a static bundle with no secrets in it, but a readable
 * bucket is also a writable-looking target and an origin nobody can bypass is
 * simply the correct default.
 *
 * ── SPA routing ─────────────────────────────────────────────────────────────
 *
 * The app reads its tenancy id from the query string and has no server, so a
 * refresh on any path must return `index.html` with **200**, not 404. Both 403
 * (which is what OAC returns for a key that is not there) and 404 are mapped.
 *
 * ── Caching, and the one file that must never be cached long ────────────────
 *
 * `/assets/*` is content-hashed by Vite and is immutable, so it takes the long
 * cache. `index.html` and `/sw.js` must not: a stale `index.html` points at
 * assets that no longer exist, and a stale service worker keeps serving the
 * old shell to a returning device for as long as its TTL, which is the classic
 * way a PWA pins itself to a dead build.
 */
import { CfnOutput, Duration, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  CacheHeaderBehavior,
  CacheQueryStringBehavior,
  CacheCookieBehavior,
  Distribution,
  HttpVersion,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
  HeadersFrameOption,
  HeadersReferrerPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export class WebStack extends Stack {
  readonly bucket: Bucket;
  readonly distribution: Distribution;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.bucket = new Bucket(this, 'WebBucket', {
      // Build output, reproducible from the repository. Unlike the evidence and
      // documents buckets this one holds nothing irreplaceable, so it is
      // destroyable — and `autoDeleteObjects` keeps a torn-down stack from
      // leaving an orphan bucket that blocks the next deploy of the same name.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      // No `websiteIndexDocument`: S3 website hosting is HTTP-only and would
      // have to be a public origin. CloudFront serves the index instead.
    });

    /**
     * Long cache for immutable, content-hashed assets.
     *
     * Query strings are not part of the key. Vite puts the hash in the
     * filename, so a query can only ever be noise — including it would let a
     * crafted `?x=1` multiply cache entries for the same bytes.
     */
    const immutableAssets = new CachePolicy(this, 'ImmutableAssetsPolicy', {
      comment: 'Content-hashed Vite output',
      defaultTtl: Duration.days(365),
      maxTtl: Duration.days(365),
      minTtl: Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      queryStringBehavior: CacheQueryStringBehavior.none(),
      headerBehavior: CacheHeaderBehavior.none(),
      cookieBehavior: CacheCookieBehavior.none(),
    });

    /**
     * The entry document and the service worker. `maxTtl: 0` means an edge
     * never holds them, so a deploy is visible on the next request rather than
     * up to a TTL later.
     */
    const alwaysRevalidate = new CachePolicy(this, 'NoStorePolicy', {
      comment: 'index.html and sw.js — a deploy must be visible immediately',
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      /*
       * No `enableAcceptEncoding*` here. With every TTL at zero CloudFront
       * classifies this as a caching-disabled policy and rejects the flags
       * outright — `The parameter EnableAcceptEncodingGzip is invalid for
       * policy with caching disabled`, which is a deploy-time failure, not a
       * synth-time one. Those flags only ever controlled how the *cache key*
       * normalises Accept-Encoding, and a policy that caches nothing has no
       * key to normalise. Responses are still compressed: that is
       * `compress: true` on the behaviour below, which is independent of this.
       */
      queryStringBehavior: CacheQueryStringBehavior.none(),
      headerBehavior: CacheHeaderBehavior.none(),
      cookieBehavior: CacheCookieBehavior.none(),
    });

    /**
     * Security headers.
     *
     * The CSP is deliberately tight and is the reason it is written out rather
     * than left to a managed policy: `connect-src` has to admit the API and the
     * S3 endpoints the browser uploads evidence to and downloads documents
     * from, and nothing else. `'unsafe-inline'` appears for styles only —
     * Tailwind's output is a stylesheet, but React still sets inline styles on
     * the compare slider — and never for scripts.
     */
    const securityHeaders = new ResponseHeadersPolicy(this, 'SecurityHeadersPolicy', {
      comment: 'Handover web security headers',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy: [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            // `blob:` is the downscaled capture preview; `data:` the icons.
            "img-src 'self' data: blob: https://*.s3.ap-south-1.amazonaws.com",
            "font-src 'self'",
            [
              "connect-src 'self'",
              'https://*.execute-api.ap-south-1.amazonaws.com',
              'https://*.s3.ap-south-1.amazonaws.com',
              'https://cognito-idp.ap-south-1.amazonaws.com',
            ].join(' '),
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
            'upgrade-insecure-requests',
          ].join('; '),
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        // A presigned URL must never leak into a Referer header on a
        // cross-origin navigation.
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
      },
    });

    const origin = S3BucketOrigin.withOriginAccessControl(this.bucket);

    this.distribution = new Distribution(this, 'WebDistribution', {
      comment: 'Handover web app',
      defaultRootObject: 'index.html',
      httpVersion: HttpVersion.HTTP2_AND_3,
      // ap-south-1 users, one region. The cheapest class that still covers
      // India; §13 does not ask for a global footprint.
      priceClass: PriceClass.PRICE_CLASS_100,
      enableIpv6: true,
      /*
       * No `minimumProtocolVersion` here. It only takes effect alongside a
       * custom ACM certificate, and this distribution uses the default
       * `*.cloudfront.net` one, whose security policy CloudFront fixes itself.
       * Setting it anyway synthesises a warning and — worse — reads as if
       * TLS 1.2 were being enforced when nothing is enforcing it. Add it back
       * together with `certificate` and `domainNames` when a custom domain
       * lands.
       */

      defaultBehavior: {
        origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        compress: true,
        cachePolicy: alwaysRevalidate,
        responseHeadersPolicy: securityHeaders,
      },

      additionalBehaviors: {
        '/assets/*': {
          origin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          compress: true,
          cachePolicy: immutableAssets,
          responseHeadersPolicy: securityHeaders,
        },
        '/icons/*': {
          origin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          compress: true,
          cachePolicy: immutableAssets,
          responseHeadersPolicy: securityHeaders,
        },
      },

      /*
       * SPA routing. A refresh on a path the bucket has no key for must return
       * the app with 200 — a 404 here would look to the tenant like their
       * tenancy had been deleted.
       *
       * `ttl: 0` so a path that becomes real after a deploy is not pinned to
       * the rewrite by an edge cache.
       */
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.seconds(0),
        },
      ],
    });

    Tags.of(this).add('handover:stack', 'web');

    new CfnOutput(this, 'WebBucketName', { value: this.bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    /** The public URL. This is what a tenant opens. */
    new CfnOutput(this, 'WebUrl', {
      value: `https://${this.distribution.distributionDomainName}`,
    });
  }
}
