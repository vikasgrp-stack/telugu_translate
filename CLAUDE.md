# BhaktiTranslate Project Guide

## Developer Profile & Project Mission
Professional web developer and expert Prompt Engineer specializing in voice-to-text transcription and multi-language translation. Mission: Build a high-fidelity "Sonix for Indian Philosophy" (BhaktiTranslate) specifically for ISKCON-based discourses.

## Tech Stack
- **Framework**: Next.js (App Router), TypeScript, Tailwind CSS
- **Primary AI (ASR/NMT)**: Gemini 2.5 Flash (Multimodal Audio-to-Text)
- **Secondary AI**: Groq (Whisper Large v3 + Llama 3.3 70B)
- **Auditor**: Gemini 2.5 Pro (High-fidelity quality judging)
- **Auth**: NextAuth.js (Google Provider)
- **Database**: Supabase (Credits & User Profiles)
- **Payments**: Stripe (Credit Top-ups)
- **Feedback Storage**: `data/learned_rules.json` (Autonomous learning loop)

## Roadmap & Active Workstreams
1. **Workstream: Monetization (Branch: `feature/monetization`)**
   - Implement Supabase profile sync with NextAuth.
   - Credit system (Minutes): 15 free mins for new users, 0.5 credits per 30s chunk.
   - Stripe Checkout integration for credit top-ups.
2. **Workstream: Real-time Streaming (Branch: `feature/streaming-translation`)**
   - Refactor `/api/transcribe` to support SSE (Server-Sent Events).
   - Implement word-by-word UI rendering for "live" feel.
   - Reduce end-to-end latency below 2 seconds.

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
  2. **Force Add API**: `git add -f app/api/sessions/save/route.ts`
  3. **Commit**: `git commit -m "Description"`
  4. **Push**: `git push origin main`
  5. **Vercel**: Deployment triggers automatically on push. Monitor at: https://vercel.com/vikasgrp-stacks-projects/bhakti_translate/deployments
  6. **Live URL**: https://bhaktitranslate.vercel.app/
  7. **Keys**: Ensure `GEMINI_API_KEY`, `GROQ_API_KEY`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `SUPABASE_URL`, and `SUPABASE_SERVICE_KEY` are set.

## Spiritual Fidelity Prompt
- **Shloka Mode**: Sanskrit chants must provide Transliteration (IAST) followed by English translation.
- **Phonetic Defense**: Explicitly correct common Whisper hallucinations (e.g., meat -> mitra, horse -> harsa).
- **ASR Scrubber Stage**: Use a dedicated pass (Llama 8B) to clean raw Whisper output before translation.
