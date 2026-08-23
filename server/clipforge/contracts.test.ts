import { describe, expect, it } from "vitest";
import { validateHighlightPlan } from "./ai";
import { ALLOWED_ASPECT_RATIOS, createJobInput, GUEST_LIMITS, inspectRemoteSource, isAllowedStatusTransition, validatePermittedSource } from "./contracts";

const visitorId = "guest_12345678901234567890";

describe("ClipForge source contracts", () => {
  it("requires an affirmative rights confirmation before job creation", () => {
    const result = createJobInput.safeParse({
      visitorId,
      sourceKind: "direct_url",
      sourceUrl: "https://media.example.com/clip.mp4",
      rightsConfirmed: false,
    });

    expect(result.success).toBe(false);
  });

  it("accepts a rights-confirmed direct HTTPS media URL and rejects webpage URLs", () => {
    const permitted = createJobInput.parse({ visitorId, sourceKind: "direct_url", sourceUrl: "https://media.example.com/clip.mp4", rightsConfirmed: true });
    const page = createJobInput.parse({ visitorId, sourceKind: "direct_url", sourceUrl: "https://media.example.com/watch", rightsConfirmed: true });

    expect(validatePermittedSource(permitted)).toEqual({ ok: true });
    expect(validatePermittedSource(page)).toMatchObject({ ok: false, code: "DIRECT_MEDIA_LINK_REQUIRED" });
  });

  it("requires both accepted media metadata and storage reference for uploads", () => {
    const input = createJobInput.parse({ visitorId, sourceKind: "upload", sourceName: "source.mp4", sourceMimeType: "video/mp4", sourceSizeBytes: 1024, sourceStorageKey: "clipforge/guest/source.mp4", rightsConfirmed: true });

    expect(validatePermittedSource(input)).toEqual({ ok: true });
  });

  it("does not inspect a direct source that resolves to a local address", async () => {
    const input = createJobInput.parse({ visitorId, sourceKind: "direct_url", sourceUrl: "https://127.0.0.1/source.mp4", rightsConfirmed: true });
    await expect(inspectRemoteSource(input)).resolves.toMatchObject({ ok: false, code: "UNSAFE_SOURCE_HOST" });
  });

  it("limits export ratios and makes terminal job states immutable", () => {
    expect(ALLOWED_ASPECT_RATIOS).toEqual(["9:16", "1:1", "16:9"]);
    expect(GUEST_LIMITS.maxClipsPerJob).toBeGreaterThan(0);
    expect(GUEST_LIMITS.maxExportsPerJob).toBeGreaterThan(0);
    expect(typeof GUEST_LIMITS.exportsEnabled).toBe("boolean");
    expect(isAllowedStatusTransition("queued", "validating")).toBe(true);
    expect(isAllowedStatusTransition("ready", "rendering")).toBe(true);
    expect(isAllowedStatusTransition("completed", "rendering")).toBe(false);
    expect(isAllowedStatusTransition("blocked", "queued")).toBe(false);
  });

  it("removes impossible AI highlight ranges and fails if no safe range remains", () => {
    const valid = { title: "A concise moment", hook: "Open strong", startMs: 1_000, endMs: 31_000, caption: "A clear caption", rationale: "Self-contained", confidence: 0.9 };
    const impossible = { ...valid, startMs: 90_000, endMs: 190_000 };

    expect(validateHighlightPlan({ candidates: [valid, impossible] }, 60_000).candidates).toEqual([valid]);
    expect(() => validateHighlightPlan({ candidates: [impossible] }, 60_000)).toThrow("valid highlight range");
  });
});
