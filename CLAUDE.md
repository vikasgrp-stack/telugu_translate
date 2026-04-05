# BhaktiTranslate Project Guide

## Developer Profile & Project Mission
Professional web developer and expert Prompt Engineer specializing in voice-to-text transcription and multi-language translation. Mission: Build a high-fidelity "Sonix for Indian Philosophy" (BhaktiTranslate) specifically for ISKCON-based discourses.

## Tech Stack
- **Framework**: Next.js (App Router), TypeScript, Tailwind CSS
- **Primary AI (ASR/NMT)**: Gemini 2.5 Flash (Multimodal Audio-to-Text)
- **Secondary AI**: Groq (Whisper Large v3 + Llama 3.3 70B)
- **Auditor**: Gemini 2.5 Pro (High-fidelity quality judging)
- **Auth**: NextAuth.js (Google Provider)
- **Feedback Storage**: `data/learned_rules.json` (Autonomous learning loop)

## Core Architectural Rules
1. **Model Hierarchy**: Always prefer Gemini 2.5 Flash for its multimodal "Indic-aware" audio understanding. Fallback to Groq/Llama if quotas are hit.
2. **Strict Grounding**: Translation must be ≤ 1.5x the input word count. Temperature must be 0 to prevent creative hallucinations.
3. **Narrative Anchors**: Always pass previous Telugu/English pairs as a "Read-Only History" to maintain continuity without repetition.
4. **Learning Loop**: Every session closure triggers an audit. Suggested rules must be surgical ("Replace X with Y") and saved to the dynamic rules file.
5. **Agentic Testing Loop**: After any significant code change, the Orchestrator MUST spawn a `generalist` sub-agent to perform an adversarial review or functional test. The feature is only complete when the sub-agent provides a "Clean Validation Report".
6. **Immutable Glossary**: Proper nouns like "Prabhupada", "Alwar", and "Vaikuntham" must never be translated or altered.

## Operational Workflow
- **Development**: `npm run dev` (Port 3000)
- **Audio Batching**: 30-60 second intervals.
- **Verification**: `npm run lint` before committing.
- **Environment**: Keys managed via `.env.local` or Vercel Dashboard.
- **Deployment Process**:
  1. **Stage Changes**: `git add .`
  2. **Force Add API**: `git add -f app/api/sessions/save/route.ts` (Required as it is inside an ignored folder).
  3. **Commit**: `git commit -m "Description"`
  4. **Push**: `git push origin main`
  5. **Vercel**: Deployment triggers automatically on push. Monitor at: https://vercel.com/vikasgrp-stacks-projects/bhakti_translate/deployments
  6. **Live URL**: https://bhaktitranslate.vercel.app/
  7. **Keys**: Ensure `GEMINI_API_KEY`, `GROQ_API_KEY`, `NEXTAUTH_SECRET`, and `NEXTAUTH_URL` are set in Vercel Settings -> Environment Variables.

## Spiritual Fidelity Prompt
- **Shloka Mode**: Sanskrit chants must provide Transliteration (IAST) followed by English translation.
- **Phonetic Defense**: Explicitly correct common Whisper hallucinations (e.g., meat -> mitra, horse -> harsa).
