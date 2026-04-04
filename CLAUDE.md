# Telugu Transcriber Project Guide

## Developer Profile & Project Mission
I am a professional web developer and expert **Prompt Engineer** specializing in the pipeline of voice-to-text transcription and multi-language translation, with a core focus on **Telugu**. 

This project is dedicated to transcribing and translating Indian philosophy classes, specifically discourses from **ISKCON preachers**. The scope covers deep spiritual topics including the **Bhagavad Gita**, **Srimad Bhagavatam**, **Chaitanya Charitamrita**, **Krishna-Radha Leelas**, and the **Mahabharata**. Every prompt update must ensure the highest quality of translation by respecting the terminology, tone, and philosophical depth of these sacred traditions.

## Build and Development Commands
- **Dev Server**: `npm run dev`
- **Production Build**: `npm run build`
- **Linting**: `npm run lint` (uses ESLint)
- **Start Production**: `npm run start`

## Coding Standards & Patterns
- **Language**: TypeScript (strict type checking enabled).
- **Framework**: Next.js 16 (App Router) with React 19.
- **Components**: Functional components with React Hooks (useCallback, useEffect, useRef).
- **Styling**: Tailwind CSS (v4) with standard Slate/Emerald/Sky color palette.
- **State Management**: React `useState` for UI state, `useRef` for persistent values across renders (especially for API context and timers).
- **API Architecture**: Next.js Route Handlers (`app/api/*/route.ts`).
- **Translation Strategy**: 
  - **Faithful Semantic Mapping**: 1:1 proportionality, no expansion, no preaching.
  - **Domain Accuracy**: Prioritize Vedic/Vaishnava terminology (Janmashtami, Japa, Caitanya, etc.).
  - **Contextual Awareness**: Respect the specific narrative logic of ISKCON-based philosophical discourses.
- **Logging**: Server-side logging to `logs/session.log` and client-side debug log panel.
- **Naming Conventions**: camelCase for variables/functions, PascalCase for components/types.
- **Verification**: Always run `npm run lint` before committing.
