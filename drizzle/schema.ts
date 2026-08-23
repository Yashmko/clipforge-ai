import { bigint, boolean, index, int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const clipJobs = mysqlTable(
  "clipJobs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    visitorId: varchar("visitorId", { length: 80 }).notNull(),
    sourceKind: mysqlEnum("sourceKind", ["upload", "direct_url", "youtube"]).notNull(),
    sourceUrl: text("sourceUrl"),
    sourceName: varchar("sourceName", { length: 255 }),
    sourceMimeType: varchar("sourceMimeType", { length: 127 }),
    sourceSizeBytes: bigint("sourceSizeBytes", { mode: "number" }),
    sourceStorageKey: varchar("sourceStorageKey", { length: 512 }),
    rightsConfirmed: boolean("rightsConfirmed").notNull().default(false),
    status: mysqlEnum("status", [
      "draft",
      "queued",
      "validating",
      "transcribing",
      "analyzing",
      "ready",
      "rendering",
      "completed",
      "blocked",
      "failed",
    ])
      .notNull()
      .default("draft"),
    progress: int("progress").notNull().default(0),
    errorCode: varchar("errorCode", { length: 64 }),
    errorMessage: text("errorMessage"),
    transcriptText: text("transcriptText"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("clipJobs_visitor_created_idx").on(table.visitorId, table.createdAt)]
);

export const clipDrafts = mysqlTable(
  "clipDrafts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    jobId: varchar("jobId", { length: 36 }).notNull(),
    title: varchar("title", { length: 140 }).notNull(),
    captionText: text("captionText"),
    startMs: int("startMs").notNull(),
    endMs: int("endMs").notNull(),
    aspectRatio: mysqlEnum("aspectRatio", ["9:16", "1:1", "16:9"]).notNull().default("9:16"),
    status: mysqlEnum("status", ["suggested", "draft", "rendering", "completed", "failed"])
      .notNull()
      .default("suggested"),
    exportStorageKey: varchar("exportStorageKey", { length: 512 }),
    exportUrl: text("exportUrl"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [index("clipDrafts_job_idx").on(table.jobId)]
);

export type ClipJob = typeof clipJobs.$inferSelect;
export type InsertClipJob = typeof clipJobs.$inferInsert;
export type ClipDraft = typeof clipDrafts.$inferSelect;
export type InsertClipDraft = typeof clipDrafts.$inferInsert;
