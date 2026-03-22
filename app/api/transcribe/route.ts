import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";
import { NextRequest } from "next/server";

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
    `You are a Specialized Spiritual Translator. 
Your goal is to translate with 100% accuracy to the Vedic/Vaishnava domain.

STRICT DOMAIN RULES:
${gContext}${recentContext}
1. PHONETIC GLOSSARY (Priority):
   - "Janmashtami" = Lord Krishna's Birthday (NEVER translate as "result" or "event").
   - "Japa" = Chanting/Meditative Recitation (NEVER "discipline").
   - "Hare Krishna" / "Hari" = God's names (NEVER "horses" or "hurry").
   - "Krishnudu" / "Kestudu" = Lord Krishna (NEVER "caste").
   - "Manasulo" = In the heart/mind (NEVER "meat").
2. NARRATIVE FIDELITY: If a story about a king, monkey, or horse is told, keep the details literal to the story. Do not use modern idioms like "take a bullet."
3. FAITHFUL MAPPING: Translate ONLY what is said. Do not add interpretations or extra sentences.
4. NO HALLUCINATION: If a word is unclear, leave it or use the spiritually logical term.

Respond with ONLY a JSON object:
{"sourceText":"<transcription>","translatedText":"<specialized-translation-in-${targetLang}>","detectedLanguage":"<language>"}`,
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
2. TERMS: 
   - "Janmashtami" = Krishna's Appearance Day.
   - "Japa" = Meditative Chanting.
   - "Harisalle" / "Hare Krishna" = Holy Names.
   - "Manasulo" = In the heart.
3. CONSTRAINTS: Zero added info. Zero modern idioms (no "takes a bullet").
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
