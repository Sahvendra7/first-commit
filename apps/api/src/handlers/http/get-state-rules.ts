/**
 * `GET /v1/state-rules/{code}` — architecture.md §5.2, §7, §9.2.
 *
 * **The one public route.** §5.2: "all routes under `/v1`, JWT-authorized
 * except `GET /v1/state-rules/{code}` and health." It carries no tenancy data
 * and no personal data — only the reviewed statutory table — so there is no
 * ownership to assert and deliberately no `callerSub` call here. The route
 * overrides the API's default authorizer in CDK; that override is the
 * security-relevant line, and it is asserted in the stack test.
 *
 * §9.2: everything this endpoint serves is reviewed data. Nothing on this path
 * touches a model, and the mapping in `domain/rules` adds nothing to what a
 * human put in the table — including, pointedly, the review date (R9).
 */
import { getStateRulesResponseSchema, stateRulePathSchema } from '@handover/shared';
import { getStateRule } from '../../adapters/dynamo/evidence-store.js';
import { UnknownStateError, resolveStateRule, toStateRulesResponse } from '../../domain/rules/state-rules.js';
import { HttpError, ok, parse, withErrors } from './http.js';
import type { ApiEvent, ApiResult } from './http.js';

export const handler = withErrors(async (event: ApiEvent): Promise<ApiResult> => {
  const { code } = parse(stateRulePathSchema, event.pathParameters ?? {});

  try {
    const rule = resolveStateRule(await getStateRule(code), code);
    return ok(getStateRulesResponseSchema.parse(toStateRulesResponse(rule)));
  } catch (err) {
    // §7: an unknown state is `422 UNKNOWN_STATE`, not a 404. The distinction
    // is real — the route exists and the request was well-formed; what is
    // missing is a reviewed entry for that state, and only `KA` ships (§15.2).
    if (err instanceof UnknownStateError) {
      throw new HttpError(422, 'UNKNOWN_STATE', `No state rules for ${err.stateCode}`);
    }
    throw err;
  }
});
