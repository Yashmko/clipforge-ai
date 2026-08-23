import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import { answerClipAssistant } from "../clipforge/ai";
import { ALLOWED_ASPECT_RATIOS, GUEST_LIMITS } from "../clipforge/contracts";
import { createClipDrafts, getClipDraftForJob, getClipDraftsForJob, getClipJobForVisitor, requestClipRender, updateClipDraft } from "../db/clipJobs";
import { publicProcedure, router } from "../_core/trpc";

const ownedJobInput = z.object({ visitorId: z.string().trim().min(20).max(80), jobId: z.string().trim().min(8).max(36) });
const aspectRatio = z.enum(ALLOWED_ASPECT_RATIOS);

async function requireReadyJob(visitorId: string, jobId: string) {
  const job = await getClipJobForVisitor(jobId, visitorId);
  if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "This clip job is not available for this guest session." });
  if (job.status !== "ready" && job.status !== "rendering" && job.status !== "completed") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Highlights are not ready yet. Wait for analysis to complete before editing this clip." });
  }
  return job;
}

export const clipDraftsRouter = router({
  list: publicProcedure.input(ownedJobInput).query(async ({ input }) => {
    await requireReadyJob(input.visitorId, input.jobId);
    return getClipDraftsForJob(input.jobId);
  }),
  create: publicProcedure
    .input(ownedJobInput.extend({ title: z.string().trim().min(1).max(140), captionText: z.string().max(4000).optional(), startMs: z.number().int().min(0), endMs: z.number().int().positive(), aspectRatio }))
    .mutation(async ({ input }) => {
      await requireReadyJob(input.visitorId, input.jobId);
      if (input.endMs <= input.startMs) throw new TRPCError({ code: "BAD_REQUEST", message: "The highlight end must be after its start." });
      const existing = await getClipDraftsForJob(input.jobId);
      if (existing.length >= GUEST_LIMITS.maxClipsPerJob) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Guest jobs are limited to ${GUEST_LIMITS.maxClipsPerJob} clip drafts.` });
      }
      const draft = { id: nanoid(21), jobId: input.jobId, title: input.title, captionText: input.captionText ?? null, startMs: input.startMs, endMs: input.endMs, aspectRatio: input.aspectRatio, status: "draft" as const, exportStorageKey: null, exportUrl: null };
      await createClipDrafts([draft]);
      return draft;
    }),
  update: publicProcedure
    .input(ownedJobInput.extend({ id: z.string().trim().min(8).max(36), title: z.string().trim().min(1).max(140), captionText: z.string().max(4000).optional(), startMs: z.number().int().min(0), endMs: z.number().int().positive(), aspectRatio }))
    .mutation(async ({ input }) => {
      await requireReadyJob(input.visitorId, input.jobId);
      if (input.endMs <= input.startMs) throw new TRPCError({ code: "BAD_REQUEST", message: "The highlight end must be after its start." });
      const draft = await getClipDraftForJob(input.id, input.jobId);
      if (!draft) throw new TRPCError({ code: "NOT_FOUND", message: "This draft is not available for the selected job." });
      await updateClipDraft(input.id, input.jobId, { title: input.title, captionText: input.captionText ?? null, startMs: input.startMs, endMs: input.endMs, aspectRatio: input.aspectRatio });
      return { ...draft, title: input.title, captionText: input.captionText ?? null, startMs: input.startMs, endMs: input.endMs, aspectRatio: input.aspectRatio };
    }),
  queueRender: publicProcedure
    .input(ownedJobInput.extend({ id: z.string().trim().min(8).max(36) }))
    .mutation(async ({ input }) => {
      await requireReadyJob(input.visitorId, input.jobId);
      const draft = await getClipDraftForJob(input.id, input.jobId);
      if (!draft) throw new TRPCError({ code: "NOT_FOUND", message: "This draft is not available for the selected job." });
      if (!GUEST_LIMITS.exportsEnabled) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Guest exports are currently unavailable. Save the draft and try again later." });
      }
      const drafts = await getClipDraftsForJob(input.jobId);
      const alreadyQueuedOrCompleted = drafts.filter(item => item.status === "rendering" || item.status === "completed").length;
      if (draft.status !== "rendering" && draft.status !== "completed" && alreadyQueuedOrCompleted >= GUEST_LIMITS.maxExportsPerJob) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Guest jobs are limited to ${GUEST_LIMITS.maxExportsPerJob} exports.` });
      }
      await requestClipRender(input.id, input.jobId);
      return { queued: true };
    }),
  assistant: publicProcedure
    .input(ownedJobInput.extend({ prompt: z.string().trim().min(1).max(1200), clipTitle: z.string().trim().min(1).max(140), captionText: z.string().max(4000), aspectRatio }))
    .mutation(async ({ input }) => {
      const job = await requireReadyJob(input.visitorId, input.jobId);
      if (!job.transcriptText) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The time-coded transcript is not available yet." });
      try {
        const answer = await answerClipAssistant({ transcript: job.transcriptText, clipTitle: input.clipTitle, captionText: input.captionText, aspectRatio: input.aspectRatio, prompt: input.prompt });
        return { answer };
      } catch (error) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error instanceof Error ? error.message : "The clip assistant is unavailable right now." });
      }
    }),
});
