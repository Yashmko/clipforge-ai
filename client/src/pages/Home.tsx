import { Button } from "@/components/ui/button";
import { AIChatBox, type Message as ClipAssistantMessage } from "@/components/AIChatBox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { getApiUrl } from "@/lib/api";
import { Check, ChevronDown, CircleAlert, Clock3, FileVideo, Film, Loader2, Play, Plus, ScissorsLineDashed, Sparkles, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type SourceKind = "upload" | "direct_url" | "youtube";
type AspectRatio = "9:16" | "1:1" | "16:9";

const sourceOptions: Array<{ value: SourceKind; label: string; note: string }> = [
  { value: "upload", label: "Local file", note: "MP4, WebM, MOV, M4V" },
  { value: "direct_url", label: "Direct media URL", note: "Public HTTPS .mp4, .webm, .mov, .m4v" },
  { value: "youtube", label: "Permitted YouTube", note: "youtube.com or youtu.be" },
];

const statusCopy: Record<string, string> = {
  draft: "Waiting for source details",
  queued: "Queued for the processing worker",
  validating: "Checking source availability",
  transcribing: "Building time-coded transcript",
  analyzing: "Finding promising moments",
  ready: "Highlights are ready to edit",
  rendering: "Rendering your export",
  completed: "Export ready to download",
  blocked: "Source needs your attention",
  failed: "Processing could not continue",
};

function createVisitorId() {
  return `guest_${crypto.randomUUID().replace(/-/g, "")}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

export default function Home() {
  const [visitorId, setVisitorId] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("upload");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [formError, setFormError] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [clipTitle, setClipTitle] = useState("Untitled highlight");
  const [captionText, setCaptionText] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [rangeStartMs, setRangeStartMs] = useState(0);
  const [rangeEndMs, setRangeEndMs] = useState(30_000);
  const [assistantMessages, setAssistantMessages] = useState<ClipAssistantMessage[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem("clipforge-visitor");
    const next = stored || createVisitorId();
    window.localStorage.setItem("clipforge-visitor", next);
    setVisitorId(next);
  }, []);

  const visitorInput = useMemo(() => ({ visitorId }), [visitorId]);
  const { data: limits } = trpc.clipJobs.limits.useQuery();
  const { data: jobs = [], isLoading: jobsLoading, refetch: refetchJobs } = trpc.clipJobs.list.useQuery(visitorInput, {
    enabled: visitorId.length > 0,
    refetchInterval: activeJobId ? 5000 : false,
  });
  const createJob = trpc.clipJobs.create.useMutation({
    onSuccess: job => {
      setActiveJobId(job.id);
      if (job.status === "blocked") {
        toast.error("Source needs attention", { description: job.errorMessage || "The source could not be processed." });
      } else {
        toast.success("Job queued", { description: "The worker will validate the source before transcription and analysis." });
      }
    },
  });
  const activeJob = jobs.find(job => job.id === activeJobId) ?? jobs[0];
  const readyForEditing = activeJob?.status === "ready" || activeJob?.status === "rendering" || activeJob?.status === "completed";
  const draftInput = useMemo(() => ({ visitorId, jobId: activeJob?.id ?? "" }), [visitorId, activeJob?.id]);
  const { data: drafts = [], refetch: refetchDrafts } = trpc.clipDrafts.list.useQuery(draftInput, { enabled: Boolean(visitorId && activeJob?.id && readyForEditing) });
  const saveDraft = trpc.clipDrafts.update.useMutation({ onSuccess: () => { toast.success("Clip draft saved"); void refetchDrafts(); } });
  const queueRender = trpc.clipDrafts.queueRender.useMutation({ onSuccess: () => { toast.success("Render queued", { description: "The FFmpeg worker will create a captioned export." }); void refetchDrafts(); void refetchJobs(); } });
  const askAssistant = trpc.clipDrafts.assistant.useMutation();
  const selectedDraft = drafts.find(draft => draft.id === selectedDraftId) ?? drafts[0];
  const isWorking = isUploading || createJob.isPending;

  useEffect(() => {
    const selected = drafts.find(draft => draft.id === selectedDraftId) ?? drafts[0];
    if (!selected) return;
    setSelectedDraftId(selected.id);
    setClipTitle(selected.title);
    setCaptionText(selected.captionText || "");
    setAspectRatio(selected.aspectRatio as AspectRatio);
    setRangeStartMs(selected.startMs);
    setRangeEndMs(selected.endMs);
  }, [drafts, selectedDraftId]);

  const saveEditorChanges = async () => {
    if (!activeJob || !selectedDraftId) return;
    if (rangeEndMs <= rangeStartMs) {
      toast.error("Check the range", { description: "The clip end needs to be after its start." });
      return;
    }
    await saveDraft.mutateAsync({ visitorId, jobId: activeJob.id, id: selectedDraftId, title: clipTitle, captionText, startMs: rangeStartMs, endMs: rangeEndMs, aspectRatio });
  };

  const sendAssistantMessage = async (prompt: string) => {
    if (!activeJob) return;
    const nextMessages = [...assistantMessages, { role: "user" as const, content: prompt }];
    setAssistantMessages(nextMessages);
    try {
      const result = await askAssistant.mutateAsync({ visitorId, jobId: activeJob.id, prompt, clipTitle, captionText, aspectRatio });
      setAssistantMessages([...nextMessages, { role: "assistant", content: result.answer }]);
    } catch (error) {
      setAssistantMessages([...nextMessages, { role: "assistant", content: error instanceof Error ? error.message : "The clip assistant is unavailable right now." }]);
    }
  };

  const requestRender = async () => {
    if (!activeJob || !selectedDraft) return;
    await queueRender.mutateAsync({ visitorId, jobId: activeJob.id, id: selectedDraft.id });
  };

  const selectFile = (file: File | undefined) => {
    setFormError("");
    if (!file) return;
    const supported = ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"];
    if (!supported.includes(file.type)) {
      setSourceFile(null);
      setFormError("Choose an MP4, WebM, MOV, or M4V file.");
      return;
    }
    if (limits && file.size > limits.maxUploadBytes) {
      setSourceFile(null);
      setFormError(`Guest uploads are limited to ${Math.round(limits.maxUploadBytes / 1024 / 1024)} MB. Trim or compress the source and try again.`);
      return;
    }
    setSourceFile(file);
  };

  const startJob = async () => {
    setFormError("");
    if (!visitorId) return;
    if (!rightsConfirmed) {
      setFormError("Confirm that you have rights or permission to process this media before continuing.");
      return;
    }

    try {
      if (sourceKind === "upload") {
        if (!sourceFile) {
          setFormError("Choose a local video to continue.");
          return;
        }
        setIsUploading(true);
        const response = await fetch(getApiUrl("/api/media/upload"), {
          method: "POST",
          headers: {
            "Content-Type": sourceFile.type,
            "x-clipforge-visitor": visitorId,
            "x-clipforge-rights-confirmed": "true",
            "x-clipforge-filename": sourceFile.name,
          },
          body: sourceFile,
        });
        const uploaded = await response.json() as { key?: string; message?: string; name?: string; mimeType?: string; sizeBytes?: number };
        if (!response.ok || !uploaded.key || !uploaded.name || !uploaded.mimeType || !uploaded.sizeBytes) {
          throw new Error(uploaded.message || "The upload could not be stored.");
        }
        await createJob.mutateAsync({
          visitorId,
          sourceKind,
          sourceName: uploaded.name,
          sourceMimeType: uploaded.mimeType,
          sourceSizeBytes: uploaded.sizeBytes,
          sourceStorageKey: uploaded.key,
          rightsConfirmed: true,
        });
      } else {
        await createJob.mutateAsync({ visitorId, sourceKind, sourceUrl: sourceUrl.trim(), rightsConfirmed: true });
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "The job could not be started. Please review the source and try again.");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white text-zinc-950 selection:bg-red-600 selection:text-white">
      <header className="border-b border-black px-5 py-4 sm:px-8 lg:px-12">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center bg-red-600 text-sm font-bold text-white">CF</div>
            <div>
              <p className="text-[15px] font-bold leading-none tracking-[-0.04em]">CLIPFORGE AI</p>
              <p className="mt-1 font-mono-ui text-[10px] uppercase tracking-[0.14em] text-zinc-500">Guest clipping workspace</p>
            </div>
          </div>
          <div className="hidden items-center gap-5 font-mono-ui text-[10px] uppercase tracking-[0.1em] text-zinc-500 sm:flex">
            <span>Permitted media only</span>
            <span className="size-1.5 bg-red-600" />
            <span>Guest mode</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-5 sm:px-8 lg:px-12">
        <section className="grid border-x border-black lg:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.6fr)]">
          <div className="relative overflow-hidden border-b border-black px-0 py-12 sm:py-16 lg:border-b-0 lg:border-r lg:py-24">
            <div className="pointer-events-none absolute inset-0 grid-rule opacity-35" />
            <div className="relative max-w-4xl px-5 sm:px-10 lg:px-14">
              <p className="font-mono-ui text-[11px] uppercase tracking-[0.16em] text-red-600">01 — source to short</p>
              <h1 className="mt-5 max-w-3xl text-5xl font-semibold leading-[0.91] tracking-[-0.075em] sm:text-7xl lg:text-[6.5rem]">
                Find the moment.<br />
                <span className="text-red-600">Forge the clip.</span>
              </h1>
              <p className="mt-8 max-w-xl text-base leading-relaxed text-zinc-600 sm:text-lg">
                Turn video you are allowed to use into concise, captioned exports. The workspace validates sources first, then guides transcription, highlight selection, and final formatting.
              </p>
              <div className="mt-10 flex flex-wrap gap-x-8 gap-y-3 font-mono-ui text-[10px] uppercase tracking-[0.11em] text-zinc-500">
                <span>AI-guided highlights</span>
                <span>Timed captions</span>
                <span>3 export frames</span>
              </div>
            </div>
          </div>

          <aside className="flex flex-col bg-zinc-950 p-6 text-white sm:p-8 lg:p-10">
            <p className="font-mono-ui text-[10px] uppercase tracking-[0.15em] text-zinc-400">Guest allowances</p>
            <div className="mt-8 grid gap-6">
              <div className="border-t border-zinc-700 pt-3"><p className="font-mono-ui text-[10px] uppercase tracking-[0.12em] text-zinc-400">Source size</p><p className="mt-1 text-3xl font-medium tracking-[-0.05em]">{limits ? `${Math.round(limits.maxUploadBytes / 1024 / 1024)} MB` : "—"}</p></div>
              <div className="border-t border-zinc-700 pt-3"><p className="font-mono-ui text-[10px] uppercase tracking-[0.12em] text-zinc-400">Source duration</p><p className="mt-1 text-3xl font-medium tracking-[-0.05em]">{limits ? `${limits.maxSourceDurationMinutes} min` : "—"}</p></div>
              <div className="border-t border-zinc-700 pt-3"><p className="font-mono-ui text-[10px] uppercase tracking-[0.12em] text-zinc-400">Suggested clips</p><p className="mt-1 text-3xl font-medium tracking-[-0.05em]">{limits ? `${limits.maxClipsPerJob} / job` : "—"}</p></div>
            </div>
            <p className="mt-auto pt-10 font-mono-ui text-[10px] leading-relaxed text-zinc-400">Files and exports are intended for short-term guest processing. Do not submit protected, private, or unauthorized media.</p>
          </aside>
        </section>

        <section className="grid border-x border-b border-black lg:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.6fr)]">
          <div className="p-5 sm:p-10 lg:border-r lg:border-black lg:p-14">
            <div className="flex items-start justify-between gap-6 border-b border-black pb-6">
              <div>
                <p className="font-mono-ui text-[11px] uppercase tracking-[0.16em] text-red-600">02 — intake</p>
                <h2 className="mt-2 text-3xl font-semibold tracking-[-0.05em]">Start a compliant job</h2>
              </div>
              <span className="hidden border border-black px-2 py-1 font-mono-ui text-[9px] uppercase tracking-[0.12em] sm:block">Required fields marked</span>
            </div>

            <div className="mt-8 grid gap-7">
              <div>
                <p className="mb-3 font-mono-ui text-[10px] uppercase tracking-[0.12em] text-zinc-500">Choose source</p>
                <div className="grid gap-px border border-black bg-black sm:grid-cols-3">
                  {sourceOptions.map(option => (
                    <button key={option.value} type="button" onClick={() => { setSourceKind(option.value); setFormError(""); }} className={`min-h-28 p-4 text-left transition-colors ${sourceKind === option.value ? "bg-red-600 text-white" : "bg-white text-black hover:bg-zinc-100"}`}>
                      <span className="block text-sm font-semibold tracking-[-0.03em]">{option.label}</span>
                      <span className={`mt-2 block font-mono-ui text-[9px] leading-relaxed uppercase tracking-[0.08em] ${sourceKind === option.value ? "text-red-100" : "text-zinc-500"}`}>{option.note}</span>
                    </button>
                  ))}
                </div>
              </div>

              {sourceKind === "upload" ? (
                <div>
                  <p className="mb-3 font-mono-ui text-[10px] uppercase tracking-[0.12em] text-zinc-500">Video file</p>
                  <input ref={inputRef} className="hidden" type="file" accept="video/mp4,video/webm,video/quicktime,video/x-m4v" onChange={event => selectFile(event.target.files?.[0])} />
                  {sourceFile ? (
                    <div className="flex items-center justify-between gap-4 border border-black bg-zinc-50 p-4">
                      <div className="flex min-w-0 items-center gap-3"><FileVideo className="size-5 shrink-0 text-red-600" /><div className="min-w-0"><p className="truncate text-sm font-medium">{sourceFile.name}</p><p className="font-mono-ui text-[10px] uppercase tracking-[0.1em] text-zinc-500">{formatBytes(sourceFile.size)} · {sourceFile.type.replace("video/", "")}</p></div></div>
                      <Button type="button" variant="ghost" size="icon" className="rounded-none hover:bg-white" onClick={() => { setSourceFile(null); if (inputRef.current) inputRef.current.value = ""; }} aria-label="Remove selected file"><X className="size-4" /></Button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => inputRef.current?.click()} className="flex min-h-36 w-full flex-col items-center justify-center border border-dashed border-black bg-white p-5 transition-colors hover:bg-zinc-50">
                      <Upload className="size-5 text-red-600" /><span className="mt-3 text-sm font-medium">Choose a video file</span><span className="mt-1 font-mono-ui text-[9px] uppercase tracking-[0.1em] text-zinc-500">MP4, WebM, MOV, M4V · maximum {limits ? Math.round(limits.maxUploadBytes / 1024 / 1024) : 250} MB</span>
                    </button>
                  )}
                </div>
              ) : (
                <div>
                  <label htmlFor="sourceUrl" className="mb-3 block font-mono-ui text-[10px] uppercase tracking-[0.12em] text-zinc-500">{sourceKind === "youtube" ? "Permitted YouTube URL" : "Direct HTTPS media URL"}</label>
                  <Input id="sourceUrl" value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} placeholder={sourceKind === "youtube" ? "https://www.youtube.com/watch?v=…" : "https://example.com/video.mp4"} className="h-12 rounded-none border-black bg-white font-mono-ui text-sm shadow-none focus-visible:ring-red-600" />
                  <p className="mt-2 font-mono-ui text-[10px] leading-relaxed text-zinc-500">{sourceKind === "youtube" ? "Use only a video you own or are authorized to repurpose. Unavailable, login-only, private, or blocked videos cannot be processed." : "Paste a direct, publicly reachable HTTPS video file. Webpages, password-protected files, and protected streams are not supported."}</p>
                </div>
              )}

              <label className="flex cursor-pointer items-start gap-3 border border-black p-4 transition-colors hover:bg-zinc-50">
                <input type="checkbox" checked={rightsConfirmed} onChange={event => setRightsConfirmed(event.target.checked)} className="mt-0.5 size-4 accent-red-600" />
                <span><span className="block text-sm font-medium">I confirm I own this media or have permission to process and export it.</span><span className="mt-1 block text-xs leading-relaxed text-zinc-600">This workspace does not bypass restrictions, CAPTCHAs, logins, paywalls, or access controls. Sources that require them will be stopped with an actionable status.</span></span>
              </label>

              {formError && <div className="flex gap-3 border-l-4 border-red-600 bg-red-50 p-4 text-sm text-red-950"><CircleAlert className="mt-0.5 size-4 shrink-0" /><p>{formError}</p></div>}
              <Button type="button" disabled={isWorking} onClick={startJob} className="h-13 w-full rounded-none bg-red-600 text-sm font-semibold uppercase tracking-[0.12em] text-white hover:bg-red-700 sm:w-auto sm:px-8">
                {isWorking ? <><Loader2 className="mr-2 size-4 animate-spin" />{isUploading ? "Storing source" : "Queueing job"}</> : <><ScissorsLineDashed className="mr-2 size-4" />Analyze source</>}
              </Button>
            </div>
          </div>

          <aside className="bg-zinc-50 p-5 sm:p-10 lg:p-10">
            <div className="flex items-center justify-between border-b border-black pb-5"><div><p className="font-mono-ui text-[10px] uppercase tracking-[0.14em] text-red-600">Queue monitor</p><h2 className="mt-1 text-xl font-semibold tracking-[-0.04em]">Your guest jobs</h2></div><Clock3 className="size-5" /></div>
            <div className="mt-6 space-y-3">
              {jobsLoading ? <div className="flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[0.1em] text-zinc-500"><Loader2 className="size-3 animate-spin" /> Loading jobs</div> : jobs.length === 0 ? <div className="border border-dashed border-zinc-400 p-5"><p className="text-sm font-medium">No job in this session</p><p className="mt-1 text-xs leading-relaxed text-zinc-600">Add a permitted source to begin validation and receive highlight suggestions.</p></div> : jobs.slice(0, 4).map(job => <button type="button" onClick={() => setActiveJobId(job.id)} key={job.id} className={`block w-full border p-4 text-left transition-colors ${activeJob?.id === job.id ? "border-black bg-white" : "border-zinc-300 hover:border-black"}`}><div className="flex items-start justify-between gap-3"><p className="line-clamp-1 text-sm font-medium">{job.sourceName || job.sourceUrl || "Untitled source"}</p><span className={`size-2 shrink-0 ${job.status === "failed" || job.status === "blocked" ? "bg-red-600" : job.status === "completed" ? "bg-emerald-600" : "bg-black"}`} /></div><p className="mt-2 font-mono-ui text-[9px] uppercase tracking-[0.1em] text-zinc-500">{statusCopy[job.status]} · {job.progress}%</p><div className="mt-3 h-1 bg-zinc-200"><div className="h-full bg-red-600" style={{ width: `${job.progress}%` }} /></div></button>)}
            </div>
            <div className="mt-7 border-t border-black pt-5 font-mono-ui text-[9px] uppercase leading-relaxed tracking-[0.1em] text-zinc-500">Guest jobs are kept for up to {limits ? limits.retentionHours : 24} hours. Processing uses a secure server worker when deployed.</div>
          </aside>
        </section>

        <section className="grid border-x border-b border-black lg:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.6fr)]">
          <div className="p-5 sm:p-10 lg:border-r lg:border-black lg:p-14">
            <div className="flex flex-wrap items-start justify-between gap-5 border-b border-black pb-6"><div><p className="font-mono-ui text-[11px] uppercase tracking-[0.16em] text-red-600">03 — edit plan</p><h2 className="mt-2 text-3xl font-semibold tracking-[-0.05em]">Shape the short</h2></div><span className="border border-black px-2 py-1 font-mono-ui text-[9px] uppercase tracking-[0.12em]">{activeJob?.status === "ready" ? "Highlights available" : "Awaiting highlights"}</span></div>
            <div className="mt-8 grid gap-8 lg:grid-cols-[0.85fr_1.15fr]">
              <div className="relative flex min-h-96 items-center justify-center overflow-hidden bg-zinc-950 p-8 text-white"><div className={`absolute border border-white/20 ${aspectRatio === "9:16" ? "h-[280px] w-[158px]" : aspectRatio === "1:1" ? "size-[220px]" : "h-[150px] w-[285px]"}`} /><div className="relative grid size-14 place-items-center rounded-full border border-white/40 bg-white/10"><Play className="ml-0.5 size-5 fill-white" /></div><div className="absolute bottom-4 left-4 right-4 flex justify-between font-mono-ui text-[9px] uppercase tracking-[0.12em] text-zinc-400"><span>Preview shell</span><span>{aspectRatio}</span></div></div>
              <div className="space-y-6">
                <div><label htmlFor="clipTitle" className="mb-2 block font-mono-ui text-[10px] uppercase tracking-[0.12em] text-zinc-500">Clip title</label><Input id="clipTitle" value={clipTitle} maxLength={140} onChange={event => setClipTitle(event.target.value)} className="h-11 rounded-none border-black bg-white shadow-none focus-visible:ring-red-600" /></div>
                <div><label htmlFor="captionText" className="mb-2 block font-mono-ui text-[10px] uppercase tracking-[0.12em] text-zinc-500">Caption direction</label><Textarea id="captionText" value={captionText} onChange={event => setCaptionText(event.target.value)} placeholder="Add a caption cue or ask the clip assistant after highlights are ready." className="min-h-25 resize-none rounded-none border-black bg-white shadow-none focus-visible:ring-red-600" /></div>
                <div><p className="mb-3 font-mono-ui text-[10px] uppercase tracking-[0.12em] text-zinc-500">Export frame</p><div className="grid grid-cols-3 gap-2">{(["9:16", "1:1", "16:9"] as AspectRatio[]).map(ratio => <button key={ratio} type="button" onClick={() => setAspectRatio(ratio)} className={`border px-2 py-3 text-sm font-semibold transition-colors ${aspectRatio === ratio ? "border-red-600 bg-red-600 text-white" : "border-black bg-white hover:bg-zinc-100"}`}>{ratio}</button>)}</div></div>
                {readyForEditing && drafts.length > 0 ? <div className="space-y-3"><p className="font-mono-ui text-[10px] uppercase tracking-[0.12em] text-zinc-500">Suggested ranges</p><div className="space-y-2">{drafts.map(draft => <button key={draft.id} type="button" onClick={() => setSelectedDraftId(draft.id)} className={`w-full border p-3 text-left ${selectedDraftId === draft.id ? "border-red-600 bg-red-50" : "border-black bg-white hover:bg-zinc-50"}`}><div className="flex items-center justify-between gap-3"><span className="text-sm font-semibold">{draft.title}</span><span className="font-mono-ui text-[9px] uppercase tracking-[0.1em] text-zinc-500">{(draft.startMs / 1000).toFixed(1)}—{(draft.endMs / 1000).toFixed(1)}s</span></div><p className="mt-1 line-clamp-1 text-xs text-zinc-600">{draft.captionText || "No caption direction yet"}</p></button>)}</div><div className="grid grid-cols-2 gap-3"><div><label htmlFor="startSeconds" className="mb-2 block font-mono-ui text-[9px] uppercase tracking-[0.1em] text-zinc-500">Start seconds</label><Input id="startSeconds" type="number" min="0" step="0.1" value={(rangeStartMs / 1000).toFixed(1)} onChange={event => setRangeStartMs(Math.max(0, Math.round(Number(event.target.value || 0) * 1000)))} className="h-10 rounded-none border-black" /></div><div><label htmlFor="endSeconds" className="mb-2 block font-mono-ui text-[9px] uppercase tracking-[0.1em] text-zinc-500">End seconds</label><Input id="endSeconds" type="number" min="0.1" step="0.1" value={(rangeEndMs / 1000).toFixed(1)} onChange={event => setRangeEndMs(Math.max(100, Math.round(Number(event.target.value || 0) * 1000)))} className="h-10 rounded-none border-black" /></div></div><Button type="button" onClick={() => void saveEditorChanges()} disabled={saveDraft.isPending} className="h-10 w-full rounded-none bg-black text-xs font-semibold uppercase tracking-[0.1em] text-white hover:bg-zinc-800">{saveDraft.isPending ? "Saving" : "Save clip edits"}</Button>{selectedDraft?.status === "completed" && selectedDraft.exportUrl ? <a href={getApiUrl(selectedDraft.exportUrl)} download className="flex h-10 items-center justify-center border border-black bg-white text-xs font-semibold uppercase tracking-[0.1em] text-black transition-colors hover:bg-zinc-100">Download export</a> : <Button type="button" onClick={() => void requestRender()} disabled={queueRender.isPending || selectedDraft?.status === "rendering"} className="h-10 w-full rounded-none bg-red-600 text-xs font-semibold uppercase tracking-[0.1em] text-white hover:bg-red-700">{queueRender.isPending || selectedDraft?.status === "rendering" ? "Rendering queued" : "Render export"}</Button>}</div> : <div className="border-l-4 border-black bg-zinc-100 p-4"><p className="font-mono-ui text-[10px] uppercase tracking-[0.1em] text-zinc-500">Highlight range</p><p className="mt-1 text-sm font-medium">Ranges unlock after server-side analysis returns time-coded suggestions.</p></div>}
              </div>
            </div>
          </div>
          <aside className="flex flex-col bg-red-600 p-5 text-white sm:p-10"><p className="font-mono-ui text-[10px] uppercase tracking-[0.14em] text-red-100">Clip assistant</p>{readyForEditing ? <div className="mt-5"><AIChatBox messages={assistantMessages} onSendMessage={prompt => void sendAssistantMessage(prompt)} isLoading={askAssistant.isPending} height="470px" className="rounded-none border-red-200 bg-white text-black shadow-none" placeholder="Ask about the hook, captions, or frame…" emptyStateMessage="Ask the assistant to refine this selected clip." suggestedPrompts={["Improve the first three seconds", "Suggest a caption hook", "Which frame suits this clip?"]} /></div> : <><div className="mt-5 border-t border-red-300 pt-5"><Sparkles className="size-6" /><h3 className="mt-5 text-3xl font-semibold leading-[0.95] tracking-[-0.06em]">Context-aware help, not guesswork.</h3><p className="mt-5 text-sm leading-relaxed text-red-100">The assistant will use your transcript and selected range to refine hooks, captions, and format choices. It does not access private accounts or work around blocked sources.</p></div><div className="mt-auto pt-10"><button type="button" disabled className="flex w-full items-center justify-between border border-red-200 bg-red-700/20 px-4 py-3 text-left text-sm font-medium disabled:opacity-100"><span>Available after analysis</span><ChevronDown className="size-4" /></button></div></>}</aside>
        </section>
      </main>
      <footer className="mx-auto max-w-[1600px] border-x border-b border-black px-5 py-4 sm:px-8 lg:px-12"><div className="flex flex-wrap items-center justify-between gap-4 font-mono-ui text-[9px] uppercase tracking-[0.11em] text-zinc-500"><span>ClipForge AI / Guest processing workspace</span><span className="flex items-center gap-2"><Check className="size-3 text-red-600" /> Rights confirmation required</span></div></footer>
    </div>
  );
}
