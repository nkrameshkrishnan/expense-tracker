/* Lazy Bedrock Runtime client singleton - same shape as stripe.js/db.js's
   module-scope clients. No API key to read at module load (Bedrock auth
   is IAM, via the Lambda's execution role - see template.yaml's
   ExtractFunction Policies), unlike stripe.js's STRIPE_SECRET_KEY. */
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

export const bedrock = new BedrockRuntimeClient({});
