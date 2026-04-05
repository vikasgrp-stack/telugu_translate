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
  isDuplicate?: boolean;
};

const GEMINI_CONTEXT_WINDOW = 1_048_576;
const GROQ_CONTEXT_WINDOW = 128_000;

const SPIRITUAL_GLOSSARY = `
## SPIRITUAL GLOSSARY (Immutable Tokens)
- Mudhal Alwar (Poigai, Bhoothath, Pey)
- Radha-Madhava, Krishna, Prabhujī, Prabhupada
- Alwar, Vaishnava, Bhagavatam, Vaikuntham
- Lakshmi Devi, Garuda, Hanuman, Harinam
- Sadhu, Sadhu-sanga, Bhakti, Jnana, Seva
- Ashta Sakhi, Vrindavan, Leela, Vahana
- Gaura Nitai, Puja room, Zamindar, Maharaja
- Dharma, Karma, Mahabharata, Bhagavad-gita, Arjuna
`;

const CANONICAL_PHRASES = `
## CANONICAL PHRASES (Use exactly as written)
- SOURCE: "మేము నిశ్చింతగా ఎన్ని ప్రోగ్రామ్స్ వచ్చినా చేయగలుగుతాం"
  CANONICAL: "we can do any number of programs without worry"
- SOURCE: "ఆచార్యులు శ్రీల ప్రభుపాదుల వారు వాళ్ళ శిష్యులు ఏవైతే చెప్పారో వాటిని ఒక పోస్ట్ మ్యాన్ గా మీ దగ్గరికి వచ్చి అందిస్తున్నాం"
  CANONICAL: "whatever the acharyas, Srila Prabhupada and his disciples said, we are delivering it to you as a postman"
- SOURCE: "మనం కూడా భగవంతుడిని ప్రతిరోజు గుర్తు చేసుకోవాలి"
  CANONICAL: "we too should remember God every day"
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

function formatContinuationNote(context?: any[]): string {
  if (!context || context.length === 0) return "";
  const lastChunk = context[context.length - 1];
  if (lastChunk.english?.endsWith("[...continues]")) {
    const lastWords = lastChunk.english.replace("[...continues]", "").split(/\s+/).slice(-5).join(" ");
    return `\n## CONTINUATION NOTE\nPrevious chunk ended mid-sentence on: "...${lastWords}"\nIf current input completes it, join naturally.\n`;
  }
  return "";
}

// ── DEDUPLICATION GATE ──
function isDuplicateInput(current: string, context?: any[]): boolean {
  if (!current || !context || context.length === 0) return false;
  const currentNorm = current.trim().substring(0, 60).toLowerCase();
  
  // Check against last 3 chunks
  return context.slice(-3).some(c => {
    if (!c.telugu) return false;
    const prevNorm = c.telugu.trim().substring(0, 60).toLowerCase();
    return currentNorm === prevNorm;
  });
}

async function scrubSourceText(groq: Groq, text: string, context: string, dynamicRules: string): Promise<string> {
  try {
    const scrubber = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content: `You are an ASR Error Corrector for Telugu/Kannada spiritual discourse.
${SPIRITUAL_GLOSSARY}
${CANONICAL_PHRASES}
${dynamicRules}
Output ONLY corrected source text.`
        },
        {
          role: "user",
          content: `HISTORY:\n${context}\n\nRAW INPUT:\n${text}\n\nCORRECTED TEXT:`
        }
      ],
      temperature: 0
    });
    return scrubber.choices[0]?.message?.content?.trim() || text;
  } catch {
    return text;
  }
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
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const historyBlock = formatContext(context);
  const continuationNote = formatContinuationNote(context);
  const dynamicRules = getDynamicRules();
  const target = targetLang.toUpperCase();

  const result = await model.generateContent({
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: mimeType || "audio/webm", data: audio } },
        { text: `Task: Translate audio to ${target}.
## RULES
1. SCRUB: Fix phonetic errors (e.g. "Yesayya" -> "ee seva").
2. DEDUP: If input is identical to HISTORY, output {"isDuplicate": true}.
3. STRICT GROUNDING: Output ≤ 1.5x word count of input.
4. PROPER NOUNS: Treat glossary as immutable tokens.
5. NO FILLER: No analogies or expansion.

${SPIRITUAL_GLOSSARY}
${CANONICAL_PHRASES}
${dynamicRules}

HISTORY: ${historyBlock}
${continuationNote}

Output Format: JSON only.
{"sourceText":"<scrubbed>","translatedText":"<translation>","detectedLanguage":"Telugu/Kannada","isDuplicate": false}` }
      ]
    }],
    generationConfig: { temperature: 0, topP: 0.1, topK: 1, responseMimeType: "application/json" }
  });

  const raw = result.response.text().trim();
  const meta = result.response.usageMetadata;
  const usage = {
    promptTokens: meta?.promptTokenCount ?? 0,
    completionTokens: meta?.candidatesTokenCount ?? 0,
    totalTokens: meta?.totalTokenCount ?? 0,
    contextWindow: GEMINI_CONTEXT_WINDOW,
  };

  try {
    const data = JSON.parse(raw);
    return { ...data, usage };
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
  const groq = new Groq({ apiKey: key! });

  const buffer = Buffer.from(audio, "base64");
  const transcription = await groq.audio.transcriptions.create({
    file: new File([buffer], "audio.webm", { type: mimeType }),
    model: "whisper-large-v3",
    response_format: "verbose_json",
    prompt: globalContext || "Spiritual discourse, Krishna, Prabhupada",
  }) as any;

  const rawSourceText = transcription.text.trim();
  
  // ── DEDUPLICATION GATE ──
  if (isDuplicateInput(rawSourceText, context)) {
    return { 
      sourceText: rawSourceText, 
      translatedText: "[Duplicate ASR loop detected - skipped]", 
      detectedLanguage: "Telugu", 
      isDuplicate: true,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, contextWindow: GROQ_CONTEXT_WINDOW }
    };
  }

  if (!rawSourceText || rawSourceText.length < 5) {
    return { sourceText: "", translatedText: "", detectedLanguage: "", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, contextWindow: GROQ_CONTEXT_WINDOW } };
  }

  const historyBlock = formatContext(context);
  const continuationNote = formatContinuationNote(context);
  const dynamicRules = getDynamicRules();
  const scrubbedSourceText = await scrubSourceText(groq, rawSourceText, historyBlock, dynamicRules);

  let actualTarget = targetLang;
  if (transcription.language === "english" && targetLang === "english") actualTarget = "hindi";

  const wordCount = scrubbedSourceText.split(/\s+/).length;
  const translationPrompt = {
    messages: [
      {
        role: "system",
        content: `LITERAL TRANSLATOR. 
- Output ≤ 1.5x word count of input.
- NO FILLER. NO REPETITION.
${SPIRITUAL_GLOSSARY}${CANONICAL_PHRASES}${dynamicRules}
Output ONLY translation.`,
      },
      {
        role: "user",
        content: `HISTORY:\n${historyBlock}\n${continuationNote}\n\nINPUT:\n${scrubbedSourceText}`,
      },
    ],
    temperature: 0,
    max_tokens: Math.max(100, Math.ceil(wordCount * 10)),
  };

  try {
    const chat = await groq.chat.completions.create({ ...translationPrompt, model: "llama-3.3-70b-versatile" } as any);
    const translatedText = chat.choices[0]?.message?.content?.trim() ?? "";
    const usage = {
      promptTokens: chat.usage?.prompt_tokens ?? 0,
      completionTokens: chat.usage?.completion_tokens ?? 0,
      totalTokens: chat.usage?.total_tokens ?? 0,
      contextWindow: GROQ_CONTEXT_WINDOW,
    };
    return { sourceText: scrubbedSourceText, translatedText, detectedLanguage: transcription.language, usage };
  } catch (err: any) {
    // Fallback logic kept same
    const fallbackChat = await groq.chat.completions.create({ ...translationPrompt, model: "llama-3.1-8b-instant" } as any);
    return { sourceText: scrubbedSourceText, translatedText: fallbackChat.choices[0]?.message?.content?.trim() || "", detectedLanguage: transcription.language, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, contextWindow: GROQ_CONTEXT_WINDOW } };
  }
}

export async function POST(req: NextRequest) {
  try {
    const { audio, mimeType, provider, groqKey, geminiKey, context, targetLanguage, globalContext } = await req.json();
    const result = provider === "groq"
      ? await transcribeWithGroq(audio, mimeType, groqKey, context, targetLanguage, globalContext)
      : await transcribeWithGemini(audio, mimeType, geminiKey, context, targetLanguage, globalContext);
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
}
