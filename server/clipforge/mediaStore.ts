import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { storageGetSignedUrl, storagePut } from "../storage";

type StoredMedia = { key: string; url: string };

function normalizeKey(key: string) {
  return key.replace(/^\/+/, "");
}

function hasExternalStorage() {
  return Boolean(process.env.S3_BUCKET && process.env.S3_REGION && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
}

function getExternalClient() {
  if (!hasExternalStorage()) throw new Error("External object storage is not configured.");
  return new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
  });
}

function externalPublicUrl(key: string) {
  const base = process.env.S3_PUBLIC_BASE_URL?.replace(/\/$/, "");
  return base ? `${base}/${encodeURIComponent(key).replace(/%2F/g, "/")}` : "";
}

export async function putMedia(key: string, data: Buffer | Uint8Array | string, contentType: string): Promise<StoredMedia> {
  const normalizedKey = normalizeKey(key);
  if (!hasExternalStorage()) return storagePut(normalizedKey, data, contentType);
  const client = getExternalClient();
  await client.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: normalizedKey, Body: data, ContentType: contentType }));
  const publicUrl = externalPublicUrl(normalizedKey);
  return { key: normalizedKey, url: publicUrl || await getMediaDownloadUrl(normalizedKey) };
}

export async function getMediaDownloadUrl(key: string) {
  const normalizedKey = normalizeKey(key);
  if (!hasExternalStorage()) return storageGetSignedUrl(normalizedKey);
  const client = getExternalClient();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: normalizedKey }), { expiresIn: 60 * 15 });
}

export function mediaStorageMode() {
  return hasExternalStorage() ? "external" : "managed-preview";
}
