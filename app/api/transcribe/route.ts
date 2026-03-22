import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";
import { NextRequest } from "next/server";

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow: number;
};

type TranscribeResult = {
  sourceText: string;
  translatedText: string;
  detectedLanguage: string;
  usage: TokenUsage;
};

const GEMINI_CONTEXT_WINDOW = 1_048_576;
const GROQ_CONTEXT_WINDOW = 128_000;

// ── Gemini ────────────────────────────────────────────────────────────────
async function transcribeWithGemini(
  audio: string,
  mimeType: string,
  apiKey?: string,
  context?: string[],
  targetLang: "english" | "hindi" = "english",
  globalContext?: string
): Promise<TranscribeResult> {
  const key = apiKey?.trim() || process.env.GEMINI_API_KEY!;
  if (!key) throw new Error("No Gemini API key configured");
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });

  const gContext = globalContext ? `GLOBAL CONTEXT: ${globalContext}\n` : "";
  const recentContext = context?.length ? `RECENT HISTORY: ${context.join(" ")}\n` : "";

  const result = await model.generateContent([
    { inlineData: { mimeType: mimeType || "audio/webm", data: audio } },
    `You are a Strict Semantic Translator. 
Your goal is 100% literal fidelity to the speaker's words.

STRICT GENERIC RULES:
${gContext}${recentContext}
1. NO PREACHING: Do not add "Your mind is like..." or "Similarly, for us..." unless the speaker explicitly said those words. 
2. ZERO ELABORATION: If the speaker tells a story, translate ONLY the story. Do not explain the "moral" or the "essence" of the story yourself.
3. DOMAIN ACCURACY: Prioritize spiritual terms: Janmashtami, Japa, Hare Krishna, Manasulo (heart/mind), Nagalu (jewelry).
4. CONCISENESS: Every English sentence must have a direct 1-to-1 counterpart in the source. Do not turn 1 sentence into 3.
5. NO MODERN SLANG: Do not use idioms like "takes a bullet" or "scolded me."

Respond with ONLY a JSON object:
{"sourceText":"<transcription>","translatedText":"<strict-semantic-translation>","detectedLanguage":"<language>"}`,
  ]);

  const raw = result.response.text().trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

  const meta = result.response.usageMetadata;
  const usage: TokenUsage = {
    promptTokens:     meta?.promptTokenCount     ?? 0,
    completionTokens: meta?.candidatesTokenCount ?? 0,
    totalTokens:      meta?.totalTokenCount      ?? 0,
    contextWindow:    GEMINI_CONTEXT_WINDOW,
  };

  try {
    return { ...JSON.parse(raw), usage };
  } catch {
    return { sourceText: "Error parsing result", translatedText: raw, detectedLanguage: "unknown", usage };
  }
}

// ── Groq ──────────────────────────────────────────────────────────────────
async function transcribeWithGroq(
  audio: string,
  mimeType: string,
  apiKey?: string,
  context?: string[],
  targetLang: "english" | "hindi" = "english",
  globalContext?: string
): Promise<TranscribeResult> {
  const key = apiKey?.trim() || process.env.GROQ_API_KEY;
  if (!key) throw new Error("No Groq API key configured");
  const groq = new Groq({ apiKey: key });

  const buffer = Buffer.from(audio, "base64");
  const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
  const file = new File([buffer], `audio.${ext}`, { type: mimeType });

  const transcription = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3",
    response_format: "verbose_json",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const sourceText = transcription.text.trim();
  const detectedLanguageCode = transcription.language || "unknown";
  const detectedLanguage = detectedLanguageCode.charAt(0).toUpperCase() + detectedLanguageCode.slice(1);
  
  if (!sourceText || sourceText.length < 5) {
    return { sourceText: "", translatedText: "", detectedLanguage: "", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, contextWindow: GROQ_CONTEXT_WINDOW } };
  }

  let actualTarget = targetLang;
  if (detectedLanguageCode.toLowerCase() === "english" && targetLang === "english") {
    actualTarget = "hindi";
  }

  const gContext = globalContext ? `GLOBAL CONTEXT: ${globalContext}\n` : "";
  const recentContext = context?.length ? `RECENT HISTORY: ${context.join(" ")}\n` : "";

  const chat = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: `You are a Strict Semantic Translator. 
RULES:
${gContext}${recentContext}
1. NO PREACHING: Do not add analogies or interpretations like "Your mind is like..." or "Similarly, we..." unless explicitly spoken.
2. ZERO EXPANSION: Mirror the source text length exactly. 
3. SPIRITUAL TERMS: Use Janmashtami, Japa, Hare Krishna, Manasulo (heart), Nagalu (jewelry).
4. No modern idioms. No dramatic flair.
5. Output ONLY the translated text in ${actualTarget}.`,
      },
      {
        role: "user",
        content: `Translate this ${detectedLanguage} talk to ${actualTarget}:\n${sourceText}`,
      },
    ],
    temperature: 0.1,
    max_tokens: 1024,
  });

  const translatedText = chat.choices[0]?.message?.content?.trim() ?? "";
  const usage = {
    promptTokens:     chat.usage?.prompt_tokens     ?? 0,
    completionTokens: chat.usage?.completion_tokens ?? 0,
    totalTokens:      chat.usage?.total_tokens      ?? 0,
    contextWindow:    GROQ_CONTEXT_WINDOW,
  };

  return { sourceText, translatedText, detectedLanguage, usage };
}

// ── Route handler ─────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const { audio, mimeType, provider, groqKey, geminiKey, context, targetLanguage, globalContext } = await req.json();
    if (!audio) return new Response(JSON.stringify({ error: "No audio" }), { status: 400 });

    const selectedProvider = provider === "groq" ? "groq" : "gemini";
    const target = targetLanguage === "hindi" ? "hindi" : "english";

    const result = selectedProvider === "groq"
      ? await transcribeWithGroq(audio, mimeType, groqKey, context, target, globalContext)
      : await transcribeWithGemini(audio, mimeType, geminiKey, context, target, globalContext);

    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
