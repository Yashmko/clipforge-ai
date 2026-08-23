import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import { createClipJob, getClipJobForVisitor, getClipJobsForVisitor } from "../db/clipJobs";
import { createJobInput, GUEST_LIMITS, inspectRemoteSource, validatePermittedSource } from "../clipforge/contracts";
import { publicProcedure, router } from "../_core/trpc";

const visitorInput = z.object({ visitorId: z.string().trim().min(20).max(80) });

export const clipJobsRouter = router({
  limits: publicProcedure.query(() => GUEST_LIMITS),
  list: publicProcedure.input(visitorInput).query(({ input }) => getClipJobsForVisitor(input.visitorId)),
  get: publicProcedure
    .input(visitorInput.extend({ id: z.string().trim().min(8).max(36) }))
    .query(async ({ input }) => {
      const job = await getClipJobForVisitor(input.id, input.visitorId);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "This clip job is not available for this guest session." });
      return job;
    }),
  create: publicProcedure.input(createJobInput).mutation(async ({ input }) => {
    const validation = validatePermittedSource(input);
    if (!validation.ok) throw new TRPCError({ code: "BAD_REQUEST", message: validation.message, cause: { sourceCode: validation.code } });

    const sourceInspection = await inspectRemoteSource(input);

    const job = {
      id: nanoid(21),
      visitorId: input.visitorId,
      sourceKind: input.sourceKind,
      sourceUrl: input.sourceUrl ?? null,
      sourceStorageKey: input.sourceStorageKey ?? null,
      sourceName: input.sourceName ?? null,
      sourceMimeType: input.sourceMimeType ?? null,
      sourceSizeBytes: input.sourceSizeBytes ?? null,
      rightsConfirmed: true,
      status: sourceInspection.ok ? "queued" as const : "blocked" as const,
      progress: sourceInspection.ok ? 5 : 0,
      errorCode: sourceInspection.ok ? null : sourceInspection.code,
      errorMessage: sourceInspection.ok ? null : sourceInspection.message,
      transcriptText: null,
    };

    await createClipJob(job);
    return job;
  }),
});
