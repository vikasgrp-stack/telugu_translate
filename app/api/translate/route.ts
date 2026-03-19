import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest } from "next/server";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export async function POST(req: NextRequest) {
  const { text, context = [] } = await req.json();

  if (!text?.trim()) {
    return new Response("Missing text", { status: 400 });
  }

  const contextBlock =
    context.length > 0
      ? `Previous Telugu segments for context (already translated, do not retranslate):\n${(context as string[]).join("\n")}\n\n`
      : "";

  const prompt = `You are a Telugu-to-English translator. Translate the given Telugu text to natural, fluent English. Output ONLY the English translation — no explanations, no transliteration, no extra commentary. The input may be a partial sentence from a continuous audio stream; preserve natural flow.

${contextBlock}Translate this Telugu text to English:
${text}`;

  let result;
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    result = await model.generateContentStream(prompt);
  } catch (err) {
    console.error("Gemini API error:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of result.stream) {
          const token = chunk.text();
          if (token) {
            controller.enqueue(new TextEncoder().encode(token));
          }
        }
        controller.close();
      } catch (err) {
        console.error("Gemini stream error:", err);
        controller.error(err);
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
