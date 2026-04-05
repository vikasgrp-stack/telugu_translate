import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";
import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";

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

const SPIRITUAL_GLOSSARY = `
## SPIRITUAL GLOSSARY (Immutable Tokens — never translate, never alter)
- Prabhupada / Prabhujī
- Radha, Krishna, Radha-Madhava
- Alwar (plural: Alwars) — Tamil Vaishnava saints
- Bhagavatam / Srimad Bhagavatam
- Vaikuntham — the spiritual abode
- Lakshmi Devi
- Garuda, Hanuman
- Harinam — the holy name
- Sadhu — a saint/renunciant
- Sadhu-sanga — association of saints
- Bhakti — devotional service
- Jnana — spiritual knowledge
- Seva — service
`;

function getDynamicRules(): string {
  try {
    const rulesPath = path.join(process.cwd(), "data", "learned_rules.json");
    if (fs.existsSync(rulesPath)) {
      const rules = JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
      if (Array.isArray(rules) && rules.length > 0) {
        return "\n## ADDITIONAL LEARNED RULES:\n" + rules.map((r: string) => `- ${r}`).join("\n");
      }
    }
  } catch (err) {
    console.error("Failed to load dynamic rules:", err);
  }
  return "";
}

function formatContext(context?: any[]): string {
  if (!context || !Array.isArray(context) || context.length === 0) return "None.";
  return context.map((c, i) => {
    const idx = i - context.length;
    return `[SEGMENT ${idx}]\nINPUT: ${c.telugu}\nOUTPUT: ${c.english}`;
  }).join("\n\n");
}

// ── Gemini ────────────────────────────────────────────────────────────────
async function transcribeWithGemini(
  audio: string,
  mimeType: string,
  apiKey?: string,
  context?: any[],
  targetLang: "english" | "hindi" = "english",
  globalContext?: string
): Promise<TranscribeResult> {
  const key = apiKey?.trim() || process.env.GEMINI_API_KEY!;
  if (!key) throw new Error("No Gemini API key configured");
  const genAI = new GoogleGenerativeAI(key);
  // Using confirmed Gemini 2.5 Flash for state-of-the-art reasoning
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const historyBlock = formatContext(context);
  const dynamicRules = getDynamicRules();
  
  // Logic for Target Language (Handles English -> Hindi fallback)
  // Note: We'll refine this once detectedLanguage is known, but for Gemini multimodal
  // we have to specify the prompt upfront. 
  const target = targetLang.toUpperCase();

  const prompt = `
You are a STRICT LITERAL TRANSLATOR for live Telugu/Kannada spiritual discourse.

## PRIME DIRECTIVE
Translate ONLY what is explicitly spoken to ${target}. Never invent, extrapolate, or repeat.

## HARD RULES
1. WORD COUNT CONSTRAINT: Your output must be ≤ 1.5x the word count of the input.
2. NO REPETITION: Never repeat phrases from SESSION HISTORY. If detected → STOP immediately.
3. NO FILLER: Do not add analogies, greetings, or philosophical expansions not in the audio.
4. PARTIAL INPUT RULE: If the input ends mid-sentence (e.g. ), translate only the complete portion and append "[...continues]".
5. PROPER NOUN PROTECTION: Treat glossary terms as immutable tokens.

${SPIRITUAL_GLOSSARY}
${dynamicRules}

## SHLOKA MODE
For Sanskrit verses only:
Line 1: Transliteration (IAST)
Line 2: ${target} meaning (one sentence max)

## TASK CONTEXT
Topic: ${globalContext || "General ISKCON spiritual discourse"}

## IMMEDIATE HISTORY (Read-only anchor — DO NOT repeat or reference)
${historyBlock}

---
## CURRENT INPUT TO TRANSLATE NOW
Output Language: ${target}
(Note: If audio is English, translate to ${target === "ENGLISH" ? "HINDI" : target})

Output Format: JSON only.
{"sourceText":"<original>","translatedText":"<translation>","detectedLanguage":"Telugu/Kannada/Mixed"}
`;

  const result = await model.generateContent({
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: mimeType || "audio/webm", data: audio } },
        { text: prompt }
      ]
    }],
    generationConfig: {
      temperature: 0,
      topP: 0.1,
      topK: 1,
      candidateCount: 1,
      responseMimeType: "application/json"
    }
  });

  const raw = result.response.text().trim();
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
    return { sourceText: "Error", translatedText: raw, detectedLanguage: "unknown", usage };
  }
}

// ── Groq ──────────────────────────────────────────────────────────────────
async function transcribeWithGroq(
  audio: string,
  mimeType: string,
  apiKey?: string,
  context?: any[],
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
    prompt: globalContext || "Spiritual discourse, Krishna, Prabhupada, Sanskrit shlokas, Telugu-to-English",
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

  const historyBlock = formatContext(context);
  const dynamicRules = getDynamicRules();
  const wordCount = sourceText.split(/\s+/).length;

  const translationPrompt = {
    messages: [
      {
        role: "system",
        content: `You are a STRICT LITERAL TRANSLATOR for spiritual discourse.
## PRIME DIRECTIVE
Translate ONLY the provided text to ${actualTarget.toUpperCase()}. Never invent, extrapolate, or repeat.

## HARD RULES
1. WORD COUNT CONSTRAINT: Your output must be ≤ 1.5x the word count of the input.
2. NO REPETITION: Never repeat phrases from SESSION HISTORY.
3. NO FILLER: Do not add analogies, greetings, or philosophical expansions.
4. PARTIAL INPUT RULE: If input ends mid-sentence, append "[...continues]".
5. PROPER NOUN PROTECTION: Treat glossary terms as immutable tokens.

${SPIRITUAL_GLOSSARY}
${dynamicRules}

## SHLOKA MODE
For Sanskrit verses only:
Line 1: Transliteration (IAST)
Line 2: ${actualTarget.toUpperCase()} meaning (one sentence max)

Output ONLY the translation. No preamble.`,
      },
      {
        role: "user",
        content: `## TASK CONTEXT
Topic: ${globalContext || "General discourse"}

## IMMEDIATE HISTORY (Read-only anchor — DO NOT repeat or reference)
${historyBlock}

---
## CURRENT INPUT TO TRANSLATE NOW
Language: ${detectedLanguage}
Approximate word count: ${wordCount}
Expected output word count: ≤ ${Math.ceil(wordCount * 1.5)}

TEXT:
${sourceText}

---
TRANSLATE THE ABOVE TEXT ONLY. DO NOT REPEAT HISTORY.`,
      },
    ],
    temperature: 0,
    max_tokens: Math.max(100, Math.ceil(wordCount * 10)), // Dynamic mechanical cap
  };

  try {
    const chat = await groq.chat.completions.create({ ...translationPrompt, model: "llama-3.3-70b-versatile" } as any);
    const translatedText = chat.choices[0]?.message?.content?.trim() ?? "";
    const usage = {
      promptTokens:     chat.usage?.prompt_tokens     ?? 0,
      completionTokens: chat.usage?.completion_tokens ?? 0,
      totalTokens:      chat.usage?.total_tokens      ?? 0,
      contextWindow:    GROQ_CONTEXT_WINDOW,
    };
    return { sourceText, translatedText, detectedLanguage, usage };
  } catch (err: any) {
    if (err?.status === 429 || String(err).includes("rate_limit_exceeded")) {
      const fallbackChat = await groq.chat.completions.create({ ...translationPrompt, model: "llama-3.1-8b-instant" } as any);
      const translatedText = fallbackChat.choices[0]?.message?.content?.trim() ?? "";
      const usage = {
        promptTokens:     fallbackChat.usage?.prompt_tokens     ?? 0,
        completionTokens: fallbackChat.usage?.completion_tokens ?? 0,
        totalTokens:      fallbackChat.usage?.total_tokens      ?? 0,
        contextWindow:    GROQ_CONTEXT_WINDOW,
      };
      return { sourceText, translatedText, detectedLanguage, usage };
    }
    throw err;
  }
}

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
