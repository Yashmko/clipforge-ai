import { invokeLLM, listLLMModels } from "../_core/llm";

export type HighlightCandidate = {
  title: string;
  hook: string;
  startMs: number;
  endMs: number;
  caption: string;
  rationale: string;
  confidence: number;
};

type HighlightPlan = { candidates: HighlightCandidate[] };

const highlightPlanSchema = {
  name: "clipforge_highlight_plan",
  strict: true,
  schema: {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            hook: { type: "string" },
            startMs: { type: "integer", minimum: 0 },
            endMs: { type: "integer", minimum: 1 },
            caption: { type: "string" },
            rationale: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["title", "hook", "startMs", "endMs", "caption", "rationale", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["candidates"],
    additionalProperties: false,
  },
} as const;

function normalizeTextContent(content: string | unknown[]) {
  if (typeof content === "string") return content;
  return content
    .filter((item): item is { type: "text"; text: string } => typeof item === "object" && item !== null && "type" in item && (item as { type?: unknown }).type === "text" && "text" in item && typeof (item as { text?: unknown }).text === "string")
    .map(item => item.text)
    .join("\n");
}

async function chooseGeminiFirstModel() {
  const configured = process.env.CLIPFORGE_MODEL?.trim();
  const catalog = await listLLMModels();
  const available = new Set(catalog.data.map(model => model.id));
  if (configured && available.has(configured)) return configured;
  return catalog.data.find(model => model.id.startsWith("gemini-"))?.id ?? catalog.data[0]?.id;
}

type ProviderRequest = { system: string; prompt: string; jsonSchema?: Record<string, unknown>; maxTokens: number };

async function invokeConfiguredGemini(request: ProviderRequest) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return undefined;
  const model = process.env.CLIPFORGE_GEMINI_MODEL?.trim() || "gemini-2.5-flash";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.prompt }] }],
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        ...(request.jsonSchema ? { responseMimeType: "application/json", responseJsonSchema: request.jsonSchema } : {}),
      },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Gemini request failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = payload.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("\n").trim();
  if (!text) throw new Error("Gemini did not return usable content for this clip request.");
  return text;
}

async function invokePreferredProvider(request: ProviderRequest) {
  const externalGemini = await invokeConfiguredGemini(request);
  if (externalGemini) return externalGemini;
  const model = await chooseGeminiFirstModel();
  if (!model) throw new Error("No compatible AI model is available for this clip request.");
  const response = await invokeLLM({
    model,
    max_tokens: request.maxTokens,
    ...(request.jsonSchema ? { response_format: { type: "json_schema" as const, json_schema: { name: "clipforge_response", strict: true, schema: request.jsonSchema } } } : {}),
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.prompt },
    ],
  });
  return normalizeTextContent(response.choices[0]?.message.content ?? "").trim();
}

export function validateHighlightPlan(plan: HighlightPlan, sourceDurationMs: number): HighlightPlan {
  const candidates = plan.candidates.filter(candidate =>
    Number.isInteger(candidate.startMs) && Number.isInteger(candidate.endMs) &&
    candidate.startMs >= 0 && candidate.endMs > candidate.startMs && candidate.endMs <= sourceDurationMs &&
    candidate.endMs - candidate.startMs <= 90_000
  );
  if (candidates.length === 0) throw new Error("The AI response did not contain a valid highlight range.");
  return { candidates };
}

export async function buildHighlightPlan(transcript: string, sourceDurationMs: number): Promise<HighlightPlan> {
  const raw = await invokePreferredProvider({
    system: "You are ClipForge's short-form video editor. Suggest up to three accurate, self-contained highlights using only the supplied transcript. Never invent words, timings, or claims. Prefer 15 to 60 second cuts with a clear hook. Return JSON only.",
    prompt: `Source duration in milliseconds: ${sourceDurationMs}.\n\nTime-coded transcript:\n${transcript}`,
    jsonSchema: highlightPlanSchema.schema,
    maxTokens: 4096,
  });
  const parsed = JSON.parse(raw) as HighlightPlan;
  return validateHighlightPlan(parsed, sourceDurationMs);
}

export async function answerClipAssistant(input: { transcript: string; clipTitle: string; captionText: string; aspectRatio: "9:16" | "1:1" | "16:9"; prompt: string }) {
  const result = await invokePreferredProvider({
    system: "You are ClipForge's precise clip-editing assistant. Give concise, practical editing guidance. Do not claim you watched media. Base suggestions only on the supplied transcript and current clip details. Do not advise bypassing access controls, platform rules, or permissions.",
    prompt: `Current title: ${input.clipTitle}\nCurrent caption direction: ${input.captionText || "None"}\nExport frame: ${input.aspectRatio}\n\nTranscript:\n${input.transcript}\n\nEditor request: ${input.prompt}`,
    maxTokens: 900,
  });
  return result || "I could not generate a clip suggestion from that request.";
}
