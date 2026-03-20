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
  contextWindow: number; // model's max context window
};

type TranscribeResult = {
  sourceText: string;
  translatedText: string;
  detectedLanguage: string;
  usage: TokenUsage;
};

// ── Gemini ────────────────────────────────────────────────────────────────
const GEMINI_CONTEXT_WINDOW = 1_048_576;

async function transcribeWithGemini(
  audio: string,
  mimeType: string,
  apiKey?: string,
  context?: string[],
  targetLang: "english" | "hindi" = "english"
): Promise<TranscribeResult> {
  const key = apiKey?.trim() || process.env.GEMINI_API_KEY!;
  if (!key) throw new Error("No Gemini API key configured");
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });

  serverLog(`Gemini: calling gemini-2.0-flash-lite with audio. Target: ${targetLang}`);

  const contextText = context?.length ? `Previous segments for context:\n${context.join("\n")}\n\n` : "";

  const result = await model.generateContent([
    { inlineData: { mimeType: mimeType || "audio/webm", data: audio } },
    `This is audio from a speaker. It could be in any language (often Telugu, English, or Hindi).

Please:
1. Detect the source language of the speech.
2. Transcribe the speech exactly as spoken in the source language.
3. Translate the speech into ${targetLang}. 
   - Note: If the detected source language is English and the requested target is English, translate it to Hindi instead.

Respond with ONLY a JSON object:
{"sourceText":"<transcribed text>","translatedText":"<translation>","detectedLanguage":"<detected language name in english>"}

If silent or no speech:
{"sourceText":"","translatedText":"","detectedLanguage":""}

${contextText}`,
  ]);

  const raw = result.response.text().trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

  serverLog(`Gemini response: ${raw.slice(0, 200)}`);

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
  } catch {
    serverLog(`Gemini JSON parse failed: ${raw}`);
    return { sourceText: "", translatedText: raw, detectedLanguage: "unknown", usage };
  }
}

// ── Groq ──────────────────────────────────────────────────────────────────
const GROQ_CONTEXT_WINDOW = 128_000;

async function transcribeWithGroq(
  audio: string,
  mimeType: string,
  apiKey?: string,
  context?: string[],
  targetLang: "english" | "hindi" = "english"
): Promise<TranscribeResult> {
  const key = apiKey?.trim() || process.env.GROQ_API_KEY;
  if (!key) throw new Error("No Groq API key configured");
  const groq = new Groq({ apiKey: key });

  const buffer = Buffer.from(audio, "base64");
  const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
  const file = new File([buffer], `audio.${ext}`, { type: mimeType });

  serverLog(`Groq: transcribing with whisper-large-v3. Target: ${targetLang}`);

  // Step 1: Transcribe with Whisper (Auto-detect language)
  const transcription = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3",
    response_format: "verbose_json",
  });

  const sourceText = transcription.text.trim();
  const detectedLanguageCode = transcription.language; // e.g., "telugu", "english"
  const detectedLanguage = detectedLanguageCode.charAt(0).toUpperCase() + detectedLanguageCode.slice(1);
  
  serverLog(`Groq Whisper result: [${detectedLanguage}] "${sourceText.slice(0, 100)}"`);

  if (!sourceText) {
    return { sourceText: "", translatedText: "", detectedLanguage: "", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, contextWindow: GROQ_CONTEXT_WINDOW } };
  }

  // Determine actual target language based on rule: English -> English becomes English -> Hindi
  let actualTarget = targetLang;
  if (detectedLanguageCode.toLowerCase() === "english" && targetLang === "english") {
    actualTarget = "hindi";
  }

  // Step 2: Translate with LLaMA
  serverLog(`Groq: translating to ${actualTarget} with llama-3.3-70b-versatile`);

  const contextText = context?.length ? `Context (previous segments): ${context.join(" ")}\n\n` : "";

  const chat = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: `You are an expert translator. Detect the tone and context of the input text and translate it into fluent, natural ${actualTarget}.
Guidelines:
- If the text is spiritual discourse, preserve Sanskrit scriptural terms.
- Output ONLY the translated text — no explanations, no extra text.`,
      },
      {
        role: "user",
        content: `${contextText}Translate this ${detectedLanguage} text to ${actualTarget}:\n${sourceText}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 1024,
  });

  const translatedText = chat.choices[0]?.message?.content?.trim() ?? "";
  const u = chat.usage;
  const usage: TokenUsage = {
    promptTokens:     u?.prompt_tokens     ?? 0,
    completionTokens: u?.completion_tokens ?? 0,
    totalTokens:      u?.total_tokens      ?? 0,
    contextWindow:    GROQ_CONTEXT_WINDOW,
  };

  return { sourceText, translatedText, detectedLanguage, usage };
}

// ── Route handler ─────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const { audio, mimeType, provider, groqKey, geminiKey, context, targetLanguage } = await req.json();

  if (!audio) {
    return new Response(JSON.stringify({ error: "No audio data" }), { status: 400 });
  }

  const selectedProvider = provider === "groq" ? "groq" : "gemini";
  const target = targetLanguage === "hindi" ? "hindi" : "english";

  try {
    const result = selectedProvider === "groq"
      ? await transcribeWithGroq(audio, mimeType, groqKey, context, target)
      : await transcribeWithGemini(audio, mimeType, geminiKey, context, target);

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const is429 = msg.includes("429");
    serverLog(`${selectedProvider} error: ${msg.slice(0, 300)}`);

    return new Response(
      JSON.stringify({ error: is429 ? "Rate limit — wait a minute and try again" : msg }),
      { status: is429 ? 429 : 500 }
    );
  }
}
