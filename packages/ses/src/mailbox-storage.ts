import { GetObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

/** Received mail up to 25 MiB, the same ceiling as the Correio receiver (core MAX_INBOUND_MIME_BYTES). */
export const MAILBOX_MAX_MIME_BYTES = 25 * 1024 * 1024;

export interface MailboxPrivateObjectLocation {
  bucket: string;
  /** Explicit SES receipt prefix, including its final slash. */
  prefix: string;
  ownerAccountId: string;
}

export interface MailboxObjectReader {
  read(input: { bucket: string; key: string }): Promise<Buffer>;
}

interface MailboxGetObjectClient {
  send(command: GetObjectCommand): Promise<{
    Body?: unknown;
    ContentLength?: number | undefined;
    ContentRange?: string | undefined;
    Metadata?: Record<string, string> | undefined;
  }>;
}

export class MailboxStorageError extends Error {
  constructor(public readonly code: "configuration" | "location" | "size" | "body" | "encryption") {
    super(`mailbox_storage_${code}`);
  }
}

function safeKey(value: string) {
  return (
    value.length > 0 &&
    Buffer.byteLength(value) <= 1024 &&
    !/[\u0000-\u001f\u007f\\]/.test(value) &&
    !value.startsWith("/") &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

/** AWS S3 only. No custom/public asset endpoint and no source-object deletion.
 * SES client-side message encryption is unsupported; ordinary S3 SSE is fine.
 */
export function createMailboxPrivateObjectReader(options: {
  region: string;
  locations: readonly MailboxPrivateObjectLocation[];
  maxBytes?: number;
  /** Captured SDK seam for offline qualification. */
  clientFactory?: (config: S3ClientConfig) => MailboxGetObjectClient;
}): MailboxObjectReader {
  const maxBytes = options.maxBytes ?? MAILBOX_MAX_MIME_BYTES;
  const locations = options.locations.map((location) => ({ ...location }));
  if (
    !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(options.region) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAILBOX_MAX_MIME_BYTES ||
    locations.length === 0 ||
    locations.some(
      (location) =>
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(location.bucket) ||
        !/^\d{12}$/.test(location.ownerAccountId) ||
        !safeKey(location.prefix) ||
        !location.prefix.endsWith("/"),
    )
  )
    throw new MailboxStorageError("configuration");
  let client: MailboxGetObjectClient | undefined;
  return {
    async read(input) {
      const location = locations.find(
        (entry) => input.bucket === entry.bucket && input.key.startsWith(entry.prefix),
      );
      if (!location || !safeKey(input.key) || input.key === location.prefix)
        throw new MailboxStorageError("location");
      if (!client) {
        const config: S3ClientConfig = {
          region: options.region,
          maxAttempts: 1,
          ignoreConfiguredEndpointUrls: true,
          requestHandler: { connectionTimeout: 10000, requestTimeout: 30000 },
        };
        client = options.clientFactory ? options.clientFactory(config) : new S3Client(config);
      }
      const result = await client.send(
        new GetObjectCommand({
          Bucket: location.bucket,
          Key: input.key,
          ExpectedBucketOwner: location.ownerAccountId,
          // Read at most cap + one byte even if the source exceeds the pilot cap.
          Range: `bytes=0-${maxBytes}`,
        }),
      );
      const body = result.Body as
        | (AsyncIterable<Uint8Array> & { destroy?: () => void })
        | undefined;
      try {
        if (!body || typeof body[Symbol.asyncIterator] !== "function")
          throw new MailboxStorageError("body");
        if (
          Object.keys(result.Metadata ?? {}).some((key) =>
            /^x-amz-(?:key(?:-v2)?|iv|matdesc|cek-alg|wrap-alg)$/i.test(key),
          )
        )
          throw new MailboxStorageError("encryption");
        const range = result.ContentRange?.match(/^bytes 0-(\d+)\/(\d+)$/);
        if (
          (result.ContentLength !== undefined &&
            (!Number.isSafeInteger(result.ContentLength) ||
              result.ContentLength < 1 ||
              result.ContentLength > maxBytes)) ||
          (result.ContentRange !== undefined &&
            (!range || Number(range[2]) > maxBytes || Number(range[1]) + 1 !== Number(range[2])))
        )
          throw new MailboxStorageError("size");
        const chunks: Buffer[] = [];
        let actualBytes = 0;
        for await (const chunk of body) {
          if (!(chunk instanceof Uint8Array)) throw new MailboxStorageError("body");
          actualBytes += chunk.byteLength;
          if (actualBytes > maxBytes) throw new MailboxStorageError("size");
          chunks.push(Buffer.from(chunk));
        }
        if (
          !actualBytes ||
          (result.ContentLength !== undefined && actualBytes !== result.ContentLength) ||
          (range && actualBytes !== Number(range[2]))
        )
          throw new MailboxStorageError("body");
        return Buffer.concat(chunks, actualBytes);
      } catch (error) {
        body?.destroy?.();
        throw error;
      }
    },
  };
}
