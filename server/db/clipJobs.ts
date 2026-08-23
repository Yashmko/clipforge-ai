import { and, desc, eq } from "drizzle-orm";
import { clipDrafts, clipJobs, type InsertClipDraft, type InsertClipJob } from "../../drizzle/schema";
import { getDb } from "../db";

export async function createClipJob(values: InsertClipJob) {
  const db = await getDb();
  if (!db) throw new Error("The job database is unavailable. Please try again shortly.");
  await db.insert(clipJobs).values(values);
  return values;
}

export async function getClipJobsForVisitor(visitorId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(clipJobs).where(eq(clipJobs.visitorId, visitorId)).orderBy(desc(clipJobs.createdAt));
}

export async function getClipJobForVisitor(id: string, visitorId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const [job] = await db.select().from(clipJobs).where(and(eq(clipJobs.id, id), eq(clipJobs.visitorId, visitorId))).limit(1);
  return job;
}

export async function updateClipJob(id: string, values: Partial<InsertClipJob>) {
  const db = await getDb();
  if (!db) throw new Error("The job database is unavailable. Please try again shortly.");
  await db.update(clipJobs).set(values).where(eq(clipJobs.id, id));
}

export async function createClipDrafts(values: InsertClipDraft[]) {
  if (values.length === 0) return;
  const db = await getDb();
  if (!db) throw new Error("The job database is unavailable. Please try again shortly.");
  await db.insert(clipDrafts).values(values);
}

export async function getClipDraftsForJob(jobId: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(clipDrafts).where(eq(clipDrafts.jobId, jobId)).orderBy(desc(clipDrafts.createdAt));
}

export async function getClipDraftForJob(id: string, jobId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const [draft] = await db.select().from(clipDrafts).where(and(eq(clipDrafts.id, id), eq(clipDrafts.jobId, jobId))).limit(1);
  return draft;
}

export async function updateClipDraft(id: string, jobId: string, values: Partial<InsertClipDraft>) {
  const db = await getDb();
  if (!db) throw new Error("The job database is unavailable. Please try again shortly.");
  await db.update(clipDrafts).set(values).where(and(eq(clipDrafts.id, id), eq(clipDrafts.jobId, jobId)));
}

export async function requestClipRender(id: string, jobId: string) {
  const db = await getDb();
  if (!db) throw new Error("The job database is unavailable. Please try again shortly.");
  await db.update(clipDrafts).set({ status: "rendering", exportStorageKey: null, exportUrl: null }).where(and(eq(clipDrafts.id, id), eq(clipDrafts.jobId, jobId)));
  await db.update(clipJobs).set({ status: "rendering", progress: 90, errorCode: null, errorMessage: null }).where(eq(clipJobs.id, jobId));
}
