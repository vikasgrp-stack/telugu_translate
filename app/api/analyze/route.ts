import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const { entries, globalContext, geminiKey } = await req.json();

  if (!entries || entries.length === 0) {
    return new Response(JSON.stringify({ error: "No feedback entries provided" }), { status: 400 });
  }

  const key = geminiKey?.trim() || process.env.GEMINI_API_KEY;
  if (!key) return new Response(JSON.stringify({ error: "Gemini key missing" }), { status: 400 });

  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feedbackList = entries.map((e: any, i: number) => `
ENTRY #${i+1}:
SOURCE: ${e.sourceText}
AI TRANSLATION: ${e.translatedText}
USER CORRECTION: ${e.correctedText}
`).join("\n");

  const prompt = `
You are an AI Prompt Engineer. Your task is to analyze mistakes made by a translation AI and suggest a generic "Instruction" or "Rule" to add to the system prompt to prevent these errors in the future.

CONTEXT: ${globalContext || "General spiritual discourse"}

FEEDBACK DATA:
${feedbackList}

ANALYSIS STEPS:
1. Identify the pattern of failure (e.g., phonetic confusion, over-elaboration, missing domain terms).
2. For each pattern, write a clear, concise instruction for the translator.
3. Combine these into a "Generic Strategy" that would fix all these cases without breaking others.

Respond with ONLY a JSON object:
{
  "summary": "<brief summary of the issues found>",
  "suggestedRules": ["rule 1", "rule 2", ...],
  "reasoning": "<why these rules will work>"
}
`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim()
      .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
    
    return new Response(text, { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
}
