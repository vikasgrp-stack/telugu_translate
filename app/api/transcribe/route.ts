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

// ── Gemini ────────────────────────────────────────────────────────────────
async function transcribeWithGemini(
  audio: string,
  mimeType: string
): Promise<{ telugu: string; english: string }> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });

  serverLog("Gemini: calling gemini-2.0-flash-lite with audio");

  const result = await model.generateContent([
    { inlineData: { mimeType: mimeType || "audio/webm", data: audio } },
    `This is Telugu audio. Please:
1. Transcribe the Telugu speech exactly as spoken
2. Translate it to English

Respond with ONLY a JSON object — no markdown, no code block:
{"telugu":"<transcribed telugu>","english":"<english translation>"}

If silent or no speech:
{"telugu":"","english":""}`,
  ]);

  const raw = result.response.text().trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

  serverLog(`Gemini response: ${raw.slice(0, 200)}`);

  try {
    return JSON.parse(raw);
  } catch {
    serverLog(`Gemini JSON parse failed: ${raw}`);
    return { telugu: "", english: raw };
  }
}

// ── Groq ──────────────────────────────────────────────────────────────────
async function transcribeWithGroq(
  audio: string,
  mimeType: string
): Promise<{ telugu: string; english: string }> {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  // Convert base64 → Buffer → File for Whisper
  const buffer = Buffer.from(audio, "base64");
  const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
  const file = new File([buffer], `audio.${ext}`, { type: mimeType });

  serverLog(`Groq: transcribing with whisper-large-v3 — file size: ${(buffer.length / 1024).toFixed(1)} KB`);

  // Step 1: Transcribe Telugu audio with Whisper
  const transcription = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3",
    language: "te",         // Telugu
    response_format: "text",
  });

  const teluguText = (transcription as unknown as string).trim();
  serverLog(`Groq Whisper result: "${teluguText.slice(0, 150)}"`);

  if (!teluguText) {
    return { telugu: "", english: "" };
  }

  // Step 2: Translate Telugu → English with LLaMA
  serverLog("Groq: translating with llama-3.3-70b-versatile");

  const chat = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: "You are a Telugu-to-English translator. Output ONLY the English translation — no explanations, no extra text.",
      },
      {
        role: "user",
        content: `Translate this Telugu text to English:\n${teluguText}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 1024,
  });

  const englishText = chat.choices[0]?.message?.content?.trim() ?? "";
  serverLog(`Groq LLaMA result: "${englishText.slice(0, 150)}"`);

  return { telugu: teluguText, english: englishText };
}

// ── Route handler ─────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const { audio, mimeType, provider } = await req.json();

  if (!audio) {
    return new Response(JSON.stringify({ error: "No audio data" }), { status: 400 });
  }

  const selectedProvider = provider === "groq" ? "groq" : "gemini";
  serverLog(`Request — provider: ${selectedProvider}, mimeType: ${mimeType}, base64 length: ${audio.length} (~${(audio.length * 0.75 / 1024).toFixed(1)} KB)`);

  try {
    const result = selectedProvider === "groq"
      ? await transcribeWithGroq(audio, mimeType)
      : await transcribeWithGemini(audio, mimeType);

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
