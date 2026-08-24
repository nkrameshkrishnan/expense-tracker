/* Lazy S3 client singleton - same shape as bedrock.js/stripe.js's
   module-scope clients. No API key to read at module load (S3 auth is
   IAM, via the Lambda's execution role - see template.yaml's DataFunction/
   ExtractFunction Policies). */
import { S3Client } from "@aws-sdk/client-s3";

export const s3 = new S3Client({});
