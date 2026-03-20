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
    `This is audio from a speech. It may contain spiritual discourse or philosophical talk.

STRICT INSTRUCTIONS:
1. STICK ONLY TO THE SPEECH IN THE AUDIO. Do not add any information, names, or concepts not mentioned.
2. NO HALLUCINATIONS. If the audio contains silence, background noise, or is unclear, do not invent text. 
3. DO NOT use flowery, poetic, or religious "filler" language unless the speaker specifically said those words.
4. If the source is English and target is English, translate to Hindi. Otherwise translate to ${targetLang}.
5. Transcribe exactly what is heard in the source language first.

Respond with ONLY a JSON object:
{"sourceText":"<exact transcription>","translatedText":"<strict translation>","detectedLanguage":"<language>"}

${contextText}`,
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

  const transcription = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3",
    response_format: "verbose_json",
  });

  const sourceText = transcription.text.trim();
  const detectedLanguageCode = transcription.language;
  const detectedLanguage = detectedLanguageCode.charAt(0).toUpperCase() + detectedLanguageCode.slice(1);
  
  if (!sourceText || sourceText.length < 5) {
    return { sourceText: "", translatedText: "", detectedLanguage: "", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, contextWindow: GROQ_CONTEXT_WINDOW } };
  }

  let actualTarget = targetLang;
  if (detectedLanguageCode.toLowerCase() === "english" && targetLang === "english") {
    actualTarget = "hindi";
  }

  serverLog(`Groq: translating to ${actualTarget}`);

  const contextText = context?.length ? `Context: ${context.join(" ")}\n\n` : "";

  const chat = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: `You are a strict, literal translator. 
RULES:
1. Translate the input text ONLY. 
2. DO NOT add any background information, religious commentary, or poetic interpretations.
3. If the input contains transcription errors (gibberish, random Bengali/Chinese characters, or nonsensical syllables), IGNORE THEM. Do not try to translate nonsense.
4. Keep the tone identical to the source.
5. Output ONLY the translated text.`,
      },
      {
        role: "user",
        content: `${contextText}Translate this ${detectedLanguage} text to ${actualTarget}:\n${sourceText}`,
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
  const { audio, mimeType, provider, groqKey, geminiKey, context, targetLanguage } = await req.json();

  if (!audio) return new Response(JSON.stringify({ error: "No audio" }), { status: 400 });

  const selectedProvider = provider === "groq" ? "groq" : "gemini";
  const target = targetLanguage === "hindi" ? "hindi" : "english";

  try {
    const result = selectedProvider === "groq"
      ? await transcribeWithGroq(audio, mimeType, groqKey, context, target)
      : await transcribeWithGemini(audio, mimeType, geminiKey, context, target);

    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    serverLog(`${selectedProvider} error: ${msg}`);
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
