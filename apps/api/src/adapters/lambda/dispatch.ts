/**
 * Async worker dispatch — architecture.md §8.1, §8.2, §3.3.
 *
 * §8.2's sequence diagram says `A-)F: async invoke` — the API hands the job to
 * the worker with `InvocationType: 'Event'` and returns `202` immediately.
 * There is no broker in this system and that is deliberate: §3.3 rules out
 * SQS, SNS and Step Functions, and Lambda's own async path already provides
 * the durability they would have been added for — an internal queue, two
 * automatic retries, and a dead-letter destination for what still fails.
 *
 * The invocation is **best effort from the caller's point of view**, and the
 * caller must treat it that way. The job record is written and committed
 * before this is called, so a dispatch that fails leaves a `QUEUED` job the
 * client can see and a re-`complete` can re-dispatch — rather than a `202`
 * with no job, or a 500 after the phase has already closed. Losing the
 * invocation degrades to a stalled progress bar; losing the job record would
 * lose the run.
 *
 * Nothing about the payload is secret. It carries two identifiers the caller
 * already holds, and the worker re-authorises nothing because it is not acting
 * on behalf of a caller — it re-reads the tenancy from the table.
 */
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { config } from '../config.js';

/** What a worker is invoked with. Kept minimal: ids, never data. */
export interface WorkerPayload {
  readonly tenancyId: string;
  readonly jobId: string;
}

let client: LambdaClient | undefined;

/** Lazily built so a unit test can mock the client after import. */
export function lambdaClient(): LambdaClient {
  return (client ??= new LambdaClient({ region: config.region() }));
}

/** Test seam. */
export function resetLambdaClient(): void {
  client = undefined;
}

/**
 * Invoke a worker asynchronously.
 *
 * Returns `true` when Lambda accepted the invocation and `false` when it did
 * not. It never throws: the decision about what a failed dispatch means
 * belongs to the caller, which has already committed a job record and would
 * otherwise have to unpick it.
 */
export async function invokeWorker(
  functionName: string,
  payload: WorkerPayload,
): Promise<boolean> {
  try {
    const out = await lambdaClient().send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(payload), 'utf8'),
      }),
    );
    // Lambda answers an accepted async invocation with 202.
    return out.StatusCode === 202;
  } catch (error) {
    console.error('worker_dispatch_failed', {
      functionName,
      jobId: payload.jobId,
      // Name only: an SDK message can carry a function ARN, and therefore an
      // account id (§10.3).
      error: (error as Error)?.name ?? 'unknown',
    });
    return false;
  }
}
