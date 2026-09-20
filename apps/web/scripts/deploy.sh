#!/usr/bin/env bash
#
# Builds the web app with a stage's real configuration and publishes it to that
# stage's CloudFront distribution.
#
# Everything it needs is read from CloudFormation outputs rather than passed in,
# so there is no list of ids to keep in step with the account and no way to
# publish a build configured for one stage into another stage's bucket.
#
#   AWS_PROFILE=handover-dev apps/web/scripts/deploy.sh
#   AWS_PROFILE=handover-dev STAGE=Prod apps/web/scripts/deploy.sh
#
# Prerequisite: the Auth, Api and Web stacks are deployed.
#
#     pnpm --filter @handover/cdk exec cdk deploy HandoverDevWeb
#
# After the first web deploy, hand the distribution's origin to the API so CORS
# admits it — the URL printed at the end is the value to pass:
#
#     pnpm --filter @handover/cdk exec cdk deploy HandoverDevApi \
#       -c webOrigin=https://dxxxxxxxx.cloudfront.net
#
set -euo pipefail

STAGE="${STAGE:-Dev}"
REGION="${AWS_REGION:-ap-south-1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "${HERE}/.." && pwd)"

# Failure is swallowed so that a stack which does not exist yet reaches the
# named check below, which can say which stack to deploy, instead of dying on
# `set -e` with a raw ValidationError.
output() {
  aws cloudformation describe-stacks \
    --stack-name "$1" --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null || true
}

echo "==> Reading stack outputs for stage ${STAGE} in ${REGION}"
API_URL="$(output "Handover${STAGE}Api" ApiUrl)"
POOL_ID="$(output "Handover${STAGE}Auth" UserPoolId)"
CLIENT_ID="$(output "Handover${STAGE}Auth" UserPoolClientId)"
BUCKET="$(output "Handover${STAGE}Web" WebBucketName)"
DIST_ID="$(output "Handover${STAGE}Web" DistributionId)"
WEB_URL="$(output "Handover${STAGE}Web" WebUrl)"

for pair in "ApiUrl:${API_URL}" "UserPoolId:${POOL_ID}" "UserPoolClientId:${CLIENT_ID}" \
            "WebBucketName:${BUCKET}" "DistributionId:${DIST_ID}"; do
  name="${pair%%:*}"; value="${pair#*:}"
  if [[ -z "${value}" || "${value}" == "None" ]]; then
    echo "error: ${name} is missing. Deploy Handover${STAGE}Web (and Auth/Api) first." >&2
    exit 1
  fi
done

echo "    API        ${API_URL}"
echo "    User pool  ${POOL_ID}"
echo "    Bucket     ${BUCKET}"

# Passed as environment rather than written to `.env.local`, so a local file is
# never overwritten and nothing configuration-shaped is left behind on disk.
echo "==> Building"
(
  cd "${WEB_DIR}"
  VITE_API_BASE_URL="${API_URL}" \
  VITE_COGNITO_USER_POOL_ID="${POOL_ID}" \
  VITE_COGNITO_CLIENT_ID="${CLIENT_ID}" \
  VITE_AWS_REGION="${REGION}" \
  pnpm exec vite build
)

DIST="${WEB_DIR}/dist"
test -f "${DIST}/index.html" || { echo "error: no build output at ${DIST}" >&2; exit 1; }

# A credential in the bundle would be published to the world by the next line,
# so the check happens before the upload rather than after it.
echo "==> Checking the bundle for anything that must not ship"
if grep -rlqE 'AKIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN [A-Z ]*PRIVATE KEY' "${DIST}"; then
  echo "error: the build output contains something credential-shaped. Not uploading." >&2
  exit 1
fi
if grep -rlq 'demo=1' "${DIST}/index.html"; then
  echo "error: index.html mentions demo mode. Not uploading." >&2
  exit 1
fi

# Hashed assets first, with a long cache. Uploaded before index.html so the
# document never references a file that is not there yet.
echo "==> Uploading immutable assets"
aws s3 sync "${DIST}" "s3://${BUCKET}" \
  --region "${REGION}" \
  --delete \
  --exclude 'index.html' --exclude 'sw.js' --exclude 'manifest.json' \
  --cache-control 'public, max-age=31536000, immutable'

# Then the three files that must never be held by a cache: a stale index.html
# points at assets that no longer exist, and a stale service worker keeps
# serving the old shell to a returning device.
echo "==> Uploading the entry document, worker and manifest"
for file in index.html sw.js manifest.json; do
  [[ -f "${DIST}/${file}" ]] || continue
  aws s3 cp "${DIST}/${file}" "s3://${BUCKET}/${file}" \
    --region "${REGION}" \
    --cache-control 'no-cache, no-store, must-revalidate'
done

echo "==> Invalidating the distribution"
aws cloudfront create-invalidation \
  --distribution-id "${DIST_ID}" --paths '/*' \
  --query 'Invalidation.Id' --output text

echo
echo "Deployed: ${WEB_URL}"
echo
echo "If this is the first deploy, allow the origin through the API's CORS:"
echo "  pnpm --filter @handover/cdk exec cdk deploy Handover${STAGE}Api -c webOrigin=${WEB_URL}"
