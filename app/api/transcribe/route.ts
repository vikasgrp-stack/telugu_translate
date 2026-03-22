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

  const gContext = globalContext ? `SPEECH CONTEXT: ${globalContext}\n` : "";
  const recentContext = context?.length ? `RECENT HISTORY: ${context.join(" ")}\n` : "";

  const result = await model.generateContent([
    { inlineData: { mimeType: mimeType || "audio/webm", data: audio } },
    `You are a Faithful Semantic Translator. 
Your goal is to map the source speech to ${targetLang} with 100% logic fidelity.

STRICT GENERIC RULES:
${gContext}${recentContext}
1. SEMANTIC ANCHORING: Every idea in the translation must exist in the source. Do not add "connective tissue," extra explanations, or "soulful" elaborations.
2. NO EXPANSION: If the speaker says one short sentence, the translation must be one short sentence. 
3. TONE MIRRORING: Match the speaker's complexity. If they use simple words, use simple words. If they are formal, be formal.
4. NO HALLUCINATION: If a word is unclear, translate it literally or omit it—do not invent a "profound" meaning to fill the gap.
5. CONTINUITY: Use the recent history only to resolve pronouns (he/she/it) and technical terms, not to continue a story that isn't being told.

Respond with ONLY a JSON object:
{"sourceText":"<transcription>","translatedText":"<faithful-translation>","detectedLanguage":"<language>"}`,
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

  const gContext = globalContext ? `SPEECH CONTEXT: ${globalContext}\n` : "";
  const recentContext = context?.length ? `RECENT HISTORY: ${context.join(" ")}\n` : "";

  const chat = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: `You are a Faithful Semantic Translator. 
RULES:
${gContext}${recentContext}
1. Translate the input text to ${actualTarget} with zero added information.
2. Keep the length and complexity identical to the source.
3. If the input is a story, do not summarize or elaborate—just translate the specific lines spoken.
4. Do not add religious or philosophical "filler" that is not explicitly in the source audio.
5. Output ONLY the translated text.`,
      },
      {
        role: "user",
        content: `Translate this ${detectedLanguage} speech to ${actualTarget}:\n${sourceText}`,
      },
    ],
    temperature: 0.1, // Near-zero temperature for maximum literalness
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
