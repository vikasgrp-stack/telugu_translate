import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";
import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";

const SESSIONS_DIR = path.join(process.cwd(), "sessions");

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const createAuditLogger = (logs: string[]) => (msg: string) => {
  const entry = `${new Date().toISOString().split("T")[1].split("Z")[0]} ${msg}`;
  logs.push(entry);
  console.log(`[SAVE] ${msg}`);
};

async function runAudit(payload: any, auditLogs: string[]) {
  const { meta, transcript } = payload;
  const geminiKey = payload.geminiKey || process.env.GEMINI_API_KEY;
  const groqKey = payload.groqKey || process.env.GROQ_API_KEY;
  const addAuditLog = createAuditLogger(auditLogs);

  // ── TRIMMING LOGIC: Ensure we fit in rate limits ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sample = transcript.slice(-10).map((c: any) => ({
    source: c.sourceText?.substring(0, 500),
    translation: c.translatedText?.substring(0, 800)
  }));

  const auditPrompt = `
You are a Translation Quality Auditor for spiritual Telugu-to-English discourses. 
Analyze the last 10 chunks of this session.
CONTEXT: ${meta.globalContext || "General ISKCON spiritual discourse"}

SESSION DATA:
${sample.map((c: any, i: number) => `[${i}] SOURCE: ${c.source}\n    TRANSLATION: ${c.translation}`).join("\n")}

TASK:
1. Identify EXACT mistakes (e.g., misheard Sanskrit, mangled proper nouns).
2. Generate surgical rules in format: "Always translate '[Phonetic Error]' as '[Correct Spiritual Term]' in this context."

Respond with ONLY a JSON object:
{
  "status": "FAIL" | "PASS",
  "issuesFound": ["List exact mistakes"],
  "suggestedRules": ["Rule: 'meat' -> 'mitra'", "Rule: 'cave' -> 'katha'"],
  "reasoning": "phonetic similarity causing drift"
}
`;

  let auditReport = null;

  // ── Phase 1: Gemini 2.5 Pro (Highest Fidelity Audit) ───────────────────
  if (geminiKey) {
    try {
      addAuditLog("Attempting Gemini 2.5-pro high-fidelity audit...");
      const genAI = new GoogleGenerativeAI(geminiKey);
      // Using verified gemini-2.5-pro for maximum judging intelligence
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
      const result = await model.generateContent(auditPrompt);
      const text = result.response.text().trim().replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
      auditReport = JSON.parse(text);
      addAuditLog(`Gemini Audit Result: ${auditReport.status}`);
      return auditReport;
    } catch (err) {
      addAuditLog(`Gemini Audit Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Phase 2: Groq Llama 70B ──────────────────────────────────────────────
  if (groqKey) {
    try {
      addAuditLog("Attempting Groq Llama-3.3-70B audit...");
      const groq = new Groq({ apiKey: groqKey });
      const chat = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: "You are a Translation Quality Auditor. Respond ONLY with JSON." },
          { role: "user", content: auditPrompt }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      });
      const text = chat.choices[0]?.message?.content?.trim() || "{}";
      auditReport = JSON.parse(text);
      addAuditLog(`Groq 70B Audit Result: ${auditReport.status}`);
      return auditReport;
    } catch (err) {
      addAuditLog(`Groq 70B Audit Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Phase 3: Groq Llama 8B ───────────────────────────────────────────────
  if (groqKey) {
    try {
      addAuditLog("Attempting Groq Llama-3.1-8B audit...");
      const groq = new Groq({ apiKey: groqKey });
      const chat = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: "You are a Translation Quality Auditor. Respond ONLY with JSON." },
          { role: "user", content: auditPrompt }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      });
      const text = chat.choices[0]?.message?.content?.trim() || "{}";
      auditReport = JSON.parse(text);
      addAuditLog(`Groq 8B Audit Result: ${auditReport.status}`);
      return auditReport;
    } catch (err) {
      addAuditLog(`Groq 8B Audit Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return null;
}

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    
    if (payload.testAudit) {
      const logs: string[] = [];
      const report = await runAudit(payload, logs);
      return new Response(JSON.stringify({ auditReport: report, auditLogs: logs, auditError: report ? undefined : "All audit models failed (Quota issue)" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    const { meta, transcript } = payload;
    if (!transcript || transcript.length === 0) {
      return new Response(JSON.stringify({ error: "Empty transcript" }), { status: 400 });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `session_${ts}.json`;
    const filePath = path.join(SESSIONS_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));

    const auditLogs: string[] = [];
    const auditReport = await runAudit(payload, auditLogs);

    if (auditReport) {
      fs.writeFileSync(filePath, JSON.stringify({ ...payload, auditReport }, null, 2));
      try {
        const rulesPath = path.join(process.cwd(), "data", "learned_rules.json");
        let existingRules: string[] = [];
        if (fs.existsSync(rulesPath)) {
          existingRules = JSON.parse(fs.readFileSync(rulesPath, "utf-8"));
        }
        const newRules = auditReport.suggestedRules || [];
        const updatedRules = [...new Set([...existingRules, ...newRules])];
        const limitedRules = updatedRules.slice(-50);
        fs.writeFileSync(rulesPath, JSON.stringify(limitedRules, null, 2));
        auditLogs.push(`${new Date().toISOString().split("T")[1].split("Z")[0]} Learning Loop: Persisted ${newRules.length} new rules.`);
      } catch (learnErr) {
        console.error("[SAVE] Learning Loop failed:", learnErr);
      }
    }

    return new Response(JSON.stringify({ 
      success: true, 
      filename, 
      auditReport,
      auditLogs,
      auditError: auditReport ? undefined : "All audit models failed or keys missing (Check logs)"
    }), { headers: { "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
}
