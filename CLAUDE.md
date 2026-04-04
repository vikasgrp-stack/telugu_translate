# Telugu Transcriber Project Guide

## Developer Profile & Project Mission
I am a professional web developer and expert **Prompt Engineer** specializing in the pipeline of voice-to-text transcription and multi-language translation, with a core focus on **Telugu**. 

This project is dedicated to transcribing and translating Indian philosophy classes, specifically discourses from **ISKCON preachers**. The scope covers deep spiritual topics including the **Bhagavad Gita**, **Srimad Bhagavatam**, **Chaitanya Charitamrita**, **Krishna-Radha Leelas**, and the **Mahabharata**. 

### Mission: "The Sonix for Indian Philosophy"
Our benchmark for quality and user experience is **Sonix.ai**. We aim to provide a professional-grade, data-first platform where spiritual discourses are treated as structured conversation objects, not just raw text.

## Product Roadmap (Prioritized)

### Priority 1: Professional Look & Feel (UI/UX Polish)
- **Dashboard Layout**: Refine the "Control Center" into a clean, focused transcript editor. Move configuration (API keys, Batch settings) to a collapsible sidebar.
- **Typography & Spacing**: Use high-readability fonts (Inter/Roboto) with optimized line-height for long-form reading.
- **Visual Feedback**: Implement confidence highlighting (visual cues for words where the AI might have struggled).

### Priority 2: Interactive Transcription (MVP)
- **Audio-to-Text Sync**: Store audio blobs per chunk so clicking a paragraph plays the corresponding audio segment.
- **Speaker Diarization**: Automatically identify and label speakers (e.g., "Prabhuji", "Questioner") using AI prompts or manual tagging.
- **Interactive Editor**: Allow basic text corrections that stay synced with the session data.

### Priority 3: Distribution & Exports
- **Subtitle Export**: Generate industry-standard SRT/VTT files for YouTube and social media.
- **Clean Document Export**: Export the full transcript + Gemini Audit Report as a professional PDF or DOCX file.
- **Workflow Integration**: Enable sharing of "read-only" session links for community review.

## Build and Development Commands
- **Dev Server**: `npm run dev`
- **Production Build**: `npm run build`
- **Linting**: `npm run lint` (uses ESLint)
- **Start Production**: `npm run start`

## Coding Standards & Patterns
- **Language**: TypeScript (strict type checking enabled).
- **Framework**: Next.js 16 (App Router) with React 19.
- **Components**: Functional components with React Hooks (useCallback, useEffect, useRef).
- **Styling**: Tailwind CSS (v4).
- **Translation Strategy**: 
  - **Faithful Semantic Mapping**: 1:1 proportionality, no expansion, no preaching.
  - **Domain Accuracy**: Prioritize Vedic/Vaishnava terminology (Janmashtami, Japa, Caitanya, etc.).
  - **Contextual Awareness**: Respect the specific narrative logic of ISKCON-based philosophical discourses.
- **Logging**: Server-side logging to `logs/session.log` and client-side debug log panel.
- **Verification**: Always run `npm run lint` before committing.
