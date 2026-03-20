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
  telugu: string;
  english: string;
  usage: TokenUsage;
};

// ── Gemini ────────────────────────────────────────────────────────────────
// gemini-2.0-flash-lite context window: 1,048,576 tokens
const GEMINI_CONTEXT_WINDOW = 1_048_576;

async function transcribeWithGemini(
  audio: string,
  mimeType: string,
  apiKey?: string
): Promise<TranscribeResult> {
  const key = apiKey?.trim() || process.env.GEMINI_API_KEY!;
  if (!key) throw new Error("No Gemini API key configured");
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });

  serverLog("Gemini: calling gemini-2.0-flash-lite with audio");

  const result = await model.generateContent([
    { inlineData: { mimeType: mimeType || "audio/webm", data: audio } },
    `This is Telugu audio, likely containing spiritual discourse referencing Sanskrit scriptures such as the Bhagavatam (Srimad Bhagavatam), Bhagavad Gita, Upanishads, Vedas, Puranas, or related Hindu texts. The speaker may quote Sanskrit shlokas/verses directly, then explain them in Telugu.

Please:
1. Transcribe the Telugu speech exactly as spoken, preserving Sanskrit words, shloka quotes, and names of deities, sages, or scriptural terms (e.g. Krishna, Vishnu, Brahma, dharma, moksha, bhakti, jnana, karma, atma, paramatma, maya, leela, samsara, etc.) as they are pronounced
2. Translate the Telugu explanation to English, using standard English equivalents for well-known Sanskrit/scriptural terms where appropriate (e.g. "dharma", "moksha", "bhakti" can be kept as-is or briefly explained)

Respond with ONLY a JSON object — no markdown, no code block:
{"telugu":"<transcribed telugu>","english":"<english translation>"}

If silent or no speech:
{"telugu":"","english":""}`,
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
  serverLog(`Gemini tokens — prompt: ${usage.promptTokens}, completion: ${usage.completionTokens}, total: ${usage.totalTokens}`);

  try {
    return { ...JSON.parse(raw), usage };
  } catch {
    serverLog(`Gemini JSON parse failed: ${raw}`);
    return { telugu: "", english: raw, usage };
  }
}

// ── Groq ──────────────────────────────────────────────────────────────────
// llama-3.3-70b-versatile context window: 128,000 tokens
const GROQ_CONTEXT_WINDOW = 128_000;

async function transcribeWithGroq(
  audio: string,
  mimeType: string,
  apiKey?: string
): Promise<TranscribeResult> {
  const key = apiKey?.trim() || process.env.GROQ_API_KEY;
  if (!key) throw new Error("No Groq API key configured");
  const groq = new Groq({ apiKey: key });

  // Convert base64 → Buffer → File for Whisper
  const buffer = Buffer.from(audio, "base64");
  const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
  const file = new File([buffer], `audio.${ext}`, { type: mimeType });

  serverLog(`Groq: transcribing with whisper-large-v3 — file size: ${(buffer.length / 1024).toFixed(1)} KB`);

  // Step 1: Transcribe Telugu audio with Whisper (no token usage returned)
  const transcription = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3",
    language: "te",         // Telugu
    response_format: "text",
  });

  const teluguText = (transcription as unknown as string).trim();
  serverLog(`Groq Whisper result: "${teluguText.slice(0, 150)}"`);

  if (!teluguText) {
    return { telugu: "", english: "", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, contextWindow: GROQ_CONTEXT_WINDOW } };
  }

  // Step 2: Translate Telugu → English with LLaMA
  serverLog("Groq: translating with llama-3.3-70b-versatile");

  const chat = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: `You are an expert Telugu-to-English translator specializing in Hindu spiritual discourse. The text you receive comes from talks or lectures that frequently reference Sanskrit scriptures — particularly the Srimad Bhagavatam, Bhagavad Gita, Upanishads, Vedas, and Puranas. The speaker often quotes Sanskrit shlokas and explains them in Telugu.

Guidelines:
- Preserve Sanskrit scriptural terms, deity names, sage names, and philosophical concepts (dharma, moksha, bhakti, jnana, karma, atma, paramatma, maya, leela, samsara, etc.) — you may keep them in Sanskrit or provide a brief English gloss
- Recognize and correctly render names of scriptures (Bhagavatam, Gita, Ramayana, Mahabharata, etc.), chapters (Cantos/Skandhas), and key figures (Krishna, Vishnu, Shiva, Narada, Sukadeva, Parikshit, Arjuna, etc.)
- Produce fluent, natural English that conveys the spiritual meaning accurately
- Output ONLY the English translation — no explanations, no extra text`,
      },
      {
        role: "user",
        content: `Translate this Telugu spiritual discourse to English:\n${teluguText}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 1024,
  });

  const englishText = chat.choices[0]?.message?.content?.trim() ?? "";
  serverLog(`Groq LLaMA result: "${englishText.slice(0, 150)}"`);

  const u = chat.usage;
  const usage: TokenUsage = {
    promptTokens:     u?.prompt_tokens     ?? 0,
    completionTokens: u?.completion_tokens ?? 0,
    totalTokens:      u?.total_tokens      ?? 0,
    contextWindow:    GROQ_CONTEXT_WINDOW,
  };
  serverLog(`Groq tokens — prompt: ${usage.promptTokens}, completion: ${usage.completionTokens}, total: ${usage.totalTokens}`);

  return { telugu: teluguText, english: englishText, usage };
}

// ── Route handler ─────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const { audio, mimeType, provider, groqKey, geminiKey } = await req.json();

  if (!audio) {
    return new Response(JSON.stringify({ error: "No audio data" }), { status: 400 });
  }

  const selectedProvider = provider === "groq" ? "groq" : "gemini";
  const usingCustomKey = selectedProvider === "groq" ? !!groqKey?.trim() : !!geminiKey?.trim();
  serverLog(`Request — provider: ${selectedProvider}, key: ${usingCustomKey ? "custom" : "server"}, mimeType: ${mimeType}, base64 length: ${audio.length} (~${(audio.length * 0.75 / 1024).toFixed(1)} KB)`);

  try {
    const result = selectedProvider === "groq"
      ? await transcribeWithGroq(audio, mimeType, groqKey)
      : await transcribeWithGemini(audio, mimeType, geminiKey);

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
