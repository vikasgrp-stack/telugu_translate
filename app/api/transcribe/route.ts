import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";
import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";

const LOG_FILE = path.join(process.cwd(), "logs", "session.log");
if (!fs.existsSync(path.join(process.cwd(), "logs"))) {
  fs.mkdirSync(path.join(process.cwd(), "logs"), { recursive: true });
}

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

  const gContext = globalContext ? `GLOBAL CONTEXT: ${globalContext}\n` : "";
  const recentContext = context?.length ? `RECENT HISTORY: ${context.join(" ")}\n` : "";

  serverLog(`Gemini: processing audio (${(audio.length/1024).toFixed(1)} KB)`);

  const result = await model.generateContent([
    { inlineData: { mimeType: mimeType || "audio/webm", data: audio } },
    `You are a Specialized Spiritual Translator. 
Your goal is to translate with 100% accuracy to the Vedic/Vaishnava domain.

STRICT DOMAIN RULES:
${gContext}${recentContext}
1. PHONETIC GLOSSARY (Priority):
   - "Janmashtami" = Lord Krishna's Birthday
   - "Japa" = Chanting/Meditative Recitation
   - "Hare Krishna" / "Hari" = God's names
   - "Krishnudu" / "Kestudu" = Lord Krishna
   - "Manasulo" = In the heart/mind
2. NARRATIVE FIDELITY: Maintain literal story details.
3. FAITHFUL MAPPING: Translate ONLY what is said.
4. NO HALLUCINATION: If a word is unclear, leave it or use the spiritually logical term.

Respond with ONLY a JSON object:
{"sourceText":"<transcription>","translatedText":"<specialized-translation-in-${targetLang}>","detectedLanguage":"<language>"}`,
  ]);

  const raw = result.response.text().trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

  serverLog(`Gemini raw response: ${raw.slice(0, 300)}`);

  const meta = result.response.usageMetadata;
  const usage: TokenUsage = {
    promptTokens:     meta?.promptTokenCount     ?? 0,
    completionTokens: meta?.candidatesTokenCount ?? 0,
    totalTokens:      meta?.totalTokenCount      ?? 0,
    contextWindow:    GEMINI_CONTEXT_WINDOW,
  };

  try {
    const parsed = JSON.parse(raw);
    return { ...parsed, usage };
  } catch (e) {
    serverLog(`Gemini JSON parse failed. Raw: ${raw}`);
    // Fallback if model doesn't return JSON
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

  serverLog(`Groq: starting Whisper transcribe...`);

  const transcription = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3",
    response_format: "verbose_json",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const sourceText = transcription.text.trim();
  const detectedLanguageCode = transcription.language || "unknown";
  const detectedLanguage = detectedLanguageCode.charAt(0).toUpperCase() + detectedLanguageCode.slice(1);
  
  serverLog(`Groq: Whisper detected ${detectedLanguage}. Text: "${sourceText.slice(0, 50)}..."`);

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
        content: `You are a Specialized Spiritual Translator. 
RULES:
${gContext}${recentContext}
1. DOMAIN ACCURACY: This is a Vaishnava/Hindu discourse.
2. TERMS: "Janmashtami", "Japa", "Hare Krishna", "Manasulo".
3. CONSTRAINTS: Zero added info.
4. Output ONLY the translated text in ${actualTarget}.`,
      },
      {
        role: "user",
        content: `Translate this ${detectedLanguage} spiritual talk to ${actualTarget}:\n${sourceText}`,
      },
    ],
    temperature: 0.1,
    max_tokens: 1024,
  });

  const translatedText = chat.choices[0]?.message?.content?.trim() ?? "";
  serverLog(`Groq: Translation complete. (${translatedText.length} chars)`);

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

    serverLog(`Request: provider=${selectedProvider}, target=${target}, contextLen=${context?.length || 0}`);

    const result = selectedProvider === "groq"
      ? await transcribeWithGroq(audio, mimeType, groqKey, context, target, globalContext)
      : await transcribeWithGemini(audio, mimeType, geminiKey, context, target, globalContext);

    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    serverLog(`ERROR in transcribe route: ${msg}`);
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
