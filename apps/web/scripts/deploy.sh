#!/usr/bin/env bash
#
# Builds the web app with a stage's real configuration and publishes it to
# Amplify Hosting.
#
#   AWS_PROFILE=handover-dev apps/web/scripts/deploy.sh
#   AWS_PROFILE=handover-dev STAGE=Prod APP_NAME=handover-web apps/web/scripts/deploy.sh
#
# ── Why Amplify and not the CloudFront stack ─────────────────────────────────
#
# `infra/cdk/lib/web-stack.ts` describes S3 + CloudFront and is the intended
# long-term hosting, but CloudFront is not available on this account:
#
#   Your account must be verified before you can add new CloudFront resources.
#   To verify your account, please contact AWS Support.
#
# That is an account gate, not a template problem — the same class of blocker as
# the Bedrock one in CLAUDE.md. Amplify Hosting fronts its own CloudFront
# distribution, needs no verification here, and gives HTTPS, SPA rewrites and a
# public URL. When the account is verified, `cdk deploy Handover<Stage>Web -c
# hosting=cloudfront` becomes available and this script is replaced.
#
# ── What it guarantees ───────────────────────────────────────────────────────
#
# Every value is read from CloudFormation outputs rather than passed in, so a
# build configured for one stage cannot be published into another's app, and
# the bundle is searched for credential-shaped strings *before* the upload
# rather than after — an upload is publication, and publication is not
# reversible by deleting the file.
#
set -euo pipefail

STAGE="${STAGE:-Dev}"
REGION="${AWS_REGION:-ap-south-1}"
APP_NAME="${APP_NAME:-handover-web}"
BRANCH="${BRANCH:-main}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "${HERE}/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# Failure is swallowed so a stack that does not exist yet reaches the named
# check below, which can say which stack to deploy, instead of dying on
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

for pair in "ApiUrl:${API_URL}" "UserPoolId:${POOL_ID}" "UserPoolClientId:${CLIENT_ID}"; do
  name="${pair%%:*}"; value="${pair#*:}"
  if [[ -z "${value}" || "${value}" == "None" ]]; then
    echo "error: ${name} is missing. Deploy Handover${STAGE}Auth and Handover${STAGE}Api first." >&2
    exit 1
  fi
done

echo "    API        ${API_URL}"
echo "    User pool  ${POOL_ID}"

# Passed as environment rather than written to `.env.local`, so a developer's
# local file is never overwritten and nothing configuration-shaped is left on
# disk by a deploy.
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

echo "==> Checking the bundle before it is published"
if grep -rlqE 'AKIA[0-9A-Z]{16}|aws_secret_access_key|BEGIN [A-Z ]*PRIVATE KEY' "${DIST}"; then
  echo "error: the build output contains something credential-shaped. Not uploading." >&2
  exit 1
fi
# The production build must not default to the fixture walkthrough.
if grep -q 'demo=1' "${DIST}/index.html"; then
  echo "error: index.html mentions demo mode. Not uploading." >&2
  exit 1
fi
# A build with no API URL in it was built without configuration and would show
# the "Not configured" screen to every visitor.
if ! grep -rq "$(printf '%s' "${API_URL}" | sed 's#https\?://##')" "${DIST}/assets"; then
  echo "error: the bundle does not contain ${API_URL}; it was built unconfigured." >&2
  exit 1
fi

echo "==> Finding the Amplify app"
APP_ID="$(aws amplify list-apps --region "${REGION}" \
  --query "apps[?name=='${APP_NAME}'].appId | [0]" --output text 2>/dev/null || true)"

# The SPA rewrite: anything without a file extension is the app, not a missing
# object, so it must return index.html with 200. A 404 here would look to a
# tenant exactly like their record having been deleted.
cat > "${WORK}/rules.json" <<'RULES'
[
  {
    "source": "</^[^.]+$|\\.(?!(css|gif|ico|jpg|jpeg|js|png|txt|svg|woff|woff2|ttf|map|json|webp|pdf|webmanifest)$)([^.]+$)/>",
    "target": "/index.html",
    "status": "200"
  },
  { "source": "/<*>", "target": "/index.html", "status": "404-200" }
]
RULES

if [[ -z "${APP_ID}" || "${APP_ID}" == "None" ]]; then
  echo "    creating ${APP_NAME}"
  APP_ID="$(aws amplify create-app --region "${REGION}" \
    --name "${APP_NAME}" --platform WEB \
    --description "Handover — rental deposit evidence capture (frontend)" \
    --custom-rules "file://${WORK}/rules.json" \
    --query 'app.appId' --output text)"
  aws amplify create-branch --region "${REGION}" \
    --app-id "${APP_ID}" --branch-name "${BRANCH}" --stage PRODUCTION >/dev/null
else
  echo "    reusing ${APP_NAME} (${APP_ID})"
  # Re-applied every deploy so the rewrite cannot drift from this file.
  aws amplify update-app --region "${REGION}" \
    --app-id "${APP_ID}" --custom-rules "file://${WORK}/rules.json" >/dev/null
  aws amplify get-branch --region "${REGION}" \
    --app-id "${APP_ID}" --branch-name "${BRANCH}" >/dev/null 2>&1 || \
    aws amplify create-branch --region "${REGION}" \
      --app-id "${APP_ID}" --branch-name "${BRANCH}" --stage PRODUCTION >/dev/null
fi

echo "==> Packaging"
(cd "${DIST}" && zip -qr "${WORK}/web.zip" .)

echo "==> Uploading"
DEPLOYMENT="$(aws amplify create-deployment --region "${REGION}" \
  --app-id "${APP_ID}" --branch-name "${BRANCH}" --output json)"
JOB_ID="$(printf '%s' "${DEPLOYMENT}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["jobId"])')"
UPLOAD_URL="$(printf '%s' "${DEPLOYMENT}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["zipUploadUrl"])')"

curl -sS -X PUT -T "${WORK}/web.zip" -H 'Content-Type: application/zip' "${UPLOAD_URL}" -o /dev/null

aws amplify start-deployment --region "${REGION}" \
  --app-id "${APP_ID}" --branch-name "${BRANCH}" --job-id "${JOB_ID}" >/dev/null

echo "==> Waiting for the deployment to finish"
for _ in $(seq 1 60); do
  STATUS="$(aws amplify get-job --region "${REGION}" \
    --app-id "${APP_ID}" --branch-name "${BRANCH}" --job-id "${JOB_ID}" \
    --query 'job.summary.status' --output text 2>/dev/null || echo PENDING)"
  case "${STATUS}" in
    SUCCEED) break ;;
    FAILED|CANCELLED) echo "error: deployment ${STATUS}" >&2; exit 1 ;;
  esac
  sleep 5
done
[[ "${STATUS}" == "SUCCEED" ]] || { echo "error: timed out waiting (last: ${STATUS})" >&2; exit 1; }

WEB_URL="https://${BRANCH}.${APP_ID}.amplifyapp.com"

echo "==> Smoke test"
code() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
ROOT="$(code "${WEB_URL}/")"
DEEP="$(code "${WEB_URL}/some/deep/path")"
echo "    /                 ${ROOT}"
echo "    /some/deep/path   ${DEEP}   (SPA rewrite)"
[[ "${ROOT}" == "200" && "${DEEP}" == "200" ]] || { echo "error: smoke test failed" >&2; exit 1; }

echo
echo "Deployed: ${WEB_URL}"
echo
echo "If this origin is new, allow it through the API's CORS:"
echo "  pnpm --filter @handover/cdk exec cdk deploy Handover${STAGE}Api -c webOrigin=${WEB_URL}"
