import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";
import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";

const LOG_FILE = path.join(process.cwd(), "logs", "session.log");
function serverLog(msg: string) {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
  try { fs.appendFileSync(LOG_FILE, `${time} [SERVER] ${msg}\n`); } catch {}
}

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

  const gContext = globalContext ? `OVERALL SPEECH CONTEXT: ${globalContext}\n` : "";
  const recentContext = context?.length ? `RECENT HISTORY: ${context.join(" ")}\n` : "";

  const result = await model.generateContent([
    { inlineData: { mimeType: mimeType || "audio/webm", data: audio } },
    `You are a Contextual Interpreter and soulful translator. 
Capture the ESSENCE and MEANING of the speech.

STRICT INSTRUCTIONS:
${gContext}${recentContext}
1. Detect language and transcribe exactly.
2. Translate to ${targetLang}. (If source is English and target is English, use Hindi).
3. SOULFUL TRANSLATION: Prioritize the speaker's intent and philosophical depth. Use natural flow.
4. NO HALLUCINATIONS: Stick to the speech, but use the provided context to understand technical terms or names correctly.
5. CONTINUITY: Ensure this segment flows naturally from the recent history.

Respond with ONLY a JSON object:
{"sourceText":"<transcription>","translatedText":"<essence-based translation>","detectedLanguage":"<language>"}`,
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
    return { sourceText: "", translatedText: raw, detectedLanguage: "unknown", usage };
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

  const gContext = globalContext ? `OVERALL SPEECH CONTEXT: ${globalContext}\n` : "";
  const recentContext = context?.length ? `RECENT HISTORY: ${context.join(" ")}\n` : "";

  const chat = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: `You are a Contextual Interpreter.
${gContext}${recentContext}
1. Capture the MEANING and SOUL of the message. 
2. Use natural, profound language in ${actualTarget}.
3. Maintain strict continuity with the provided context.
4. Output ONLY the translated text.`,
      },
      {
        role: "user",
        content: `Capture the essence of this ${detectedLanguage} speech in ${actualTarget}:\n${sourceText}`,
      },
    ],
    temperature: 0.3,
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
  const { audio, mimeType, provider, groqKey, geminiKey, context, targetLanguage, globalContext } = await req.json();
  if (!audio) return new Response(JSON.stringify({ error: "No audio" }), { status: 400 });

  const selectedProvider = provider === "groq" ? "groq" : "gemini";
  const target = targetLanguage === "hindi" ? "hindi" : "english";

  try {
    const result = selectedProvider === "groq"
      ? await transcribeWithGroq(audio, mimeType, groqKey, context, target, globalContext)
      : await transcribeWithGemini(audio, mimeType, geminiKey, context, target, globalContext);

    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500 });
  }
}
