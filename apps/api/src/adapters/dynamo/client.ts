/**
 * The DynamoDB document client — architecture.md §6.1.
 *
 * One client per container, created lazily. `aws-sdk-client-mock` intercepts at
 * the client level, so tests never need this module to be a singleton; the
 * laziness is for cold starts, and the `reset` hook is so a test can force a
 * fresh client after changing the environment.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { config } from '../config.js';

let cached: DynamoDBDocumentClient | undefined;

export function documentClient(): DynamoDBDocumentClient {
  if (!cached) {
    cached = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region() }), {
      marshallOptions: {
        // A tenancy with no handover date must not write `handoverDate: null`:
        // the item shapes treat absent and null differently, and a null would
        // satisfy `attribute_exists` in a condition expression.
        removeUndefinedValues: true,
        convertClassInstanceToMap: false,
      },
    });
  }
  return cached;
}

/** Drop the cached client. Tests only. */
export function resetDocumentClient(): void {
  cached = undefined;
}
