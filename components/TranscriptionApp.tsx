"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import pkg from "../package.json";

const LS_GROQ_KEY   = "tt_groq_key";
const LS_GEMINI_KEY = "tt_gemini_key";
const LS_CONTEXT    = "tt_global_context";

const ENABLE_DONATIONS = process.env.NEXT_PUBLIC_ENABLE_DONATIONS === "true";
const DONATION_URL     = process.env.NEXT_PUBLIC_DONATION_URL || "";

type TranscriptChunk = {
  id: string;
  sourceText: string;
  translatedText: string;
  detectedLanguage?: string;
  isTranslating: boolean;
  error?: boolean;
};

type TokenStats = {
  sessionTotal: number;
  lastPrompt: number;
  lastCompletion: number;
  lastBatch: number;
  batchCount: number;
  audioSeconds: number;
  sessionStartMs: number;
};

type LogEntry = {
  id: number;
  time: string;
  level: "info" | "warn" | "error" | "audio" | "api";
  msg: string;
};

const LOG_COLORS: Record<LogEntry["level"], string> = {
  info:  "text-slate-400",
  warn:  "text-yellow-400",
  error: "text-red-400",
  audio: "text-emerald-400",
  api:   "text-sky-400",
};

let logIdCounter = 0;

export default function TranscriptionApp() {
  const [isListening, setIsListening]     = useState(false);
  const [chunks, setChunks]               = useState<TranscriptChunk[]>([]);
  const [error, setError]                 = useState<string | null>(null);
  const [nextFlushIn, setNextFlushIn]     = useState<number | null>(null);
  const [batchSec, setBatchSec]           = useState(30);
  const [logs, setLogs]                   = useState<LogEntry[]>([]);
  const [showLogs, setShowLogs]           = useState(false);
  const [recording, setRecording]         = useState(false);
  const [provider, setProvider]           = useState<"gemini" | "groq">("groq");
  const [targetLanguage, setTargetLanguage] = useState<"english" | "hindi">("english");
  const [globalContext, setGlobalContext] = useState("");
  const [onlineCount, setOnlineCount]     = useState(1);
  const [tokenStats, setTokenStats]       = useState<TokenStats | null>(null);
  const tokenStatsRef                     = useRef<TokenStats | null>(null);
  const [groqKey, setGroqKey]             = useState("");
  const [geminiKey, setGeminiKey]         = useState("");
  const [showKeys, setShowKeys]           = useState(false);
  const [keysVisible, setKeysVisible]     = useState(false);
  const groqKeyRef                        = useRef("");
  const geminiKeyRef                      = useRef("");
  const sessionIdRef                      = useRef<string>("");

  const batchSecRef       = useRef(batchSec);
  const providerRef       = useRef(provider);
  const targetLanguageRef = useRef(targetLanguage);
  const globalContextRef  = useRef(globalContext);
  const isListeningRef    = useRef(false);
  const chunksRef         = useRef<TranscriptChunk[]>([]);
  
  const mediaRecorderRef  = useRef<MediaRecorder | null>(null);
  const batchTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingLogsRef    = useRef<LogEntry[]>([]);
  const logFlushTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourcePanelRef    = useRef<HTMLDivElement>(null);
  const translatedPanelRef = useRef<HTMLDivElement>(null);
  const logPanelRef       = useRef<HTMLDivElement>(null);

  // ── Presence Heartbeat ────────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionIdRef.current) {
      sessionIdRef.current = Math.random().toString(36).substring(2, 15);
    }

    const sendHeartbeat = async () => {
      try {
        const res = await fetch("/api/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sessionIdRef.current }),
        });
        const data = await res.json();
        if (data.onlineCount) setOnlineCount(data.onlineCount);
      } catch {
        // ignore presence errors
      }
    };

    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 30000); // every 30s
    return () => clearInterval(interval);
  }, []);

  // Sync refs
  useEffect(() => { batchSecRef.current = batchSec; }, [batchSec]);
  useEffect(() => { providerRef.current = provider; }, [provider]);
  useEffect(() => { targetLanguageRef.current = targetLanguage; }, [targetLanguage]);
  useEffect(() => { globalContextRef.current = globalContext; localStorage.setItem(LS_CONTEXT, globalContext); }, [globalContext]);
  useEffect(() => { chunksRef.current = chunks; }, [chunks]);

  // Auto-scroll on new chunks
  useEffect(() => {
    scrollPanels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunks]);

  useEffect(() => {
    setGroqKey(localStorage.getItem(LS_GROQ_KEY)   ?? "");
    setGeminiKey(localStorage.getItem(LS_GEMINI_KEY) ?? "");
    setGlobalContext(localStorage.getItem(LS_CONTEXT) ?? "");
  }, []);

  useEffect(() => { groqKeyRef.current = groqKey;     localStorage.setItem(LS_GROQ_KEY,   groqKey);   }, [groqKey]);
  useEffect(() => { geminiKeyRef.current = geminiKey; localStorage.setItem(LS_GEMINI_KEY, geminiKey); }, [geminiKey]);

  const flushLogsToServer = useCallback((entries: LogEntry[]) => {
    if (!entries.length) return;
    fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    }).catch(() => {});
  }, []);

  const addLog = useCallback((level: LogEntry["level"], msg: string) => {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}.${String(now.getMilliseconds()).padStart(3,"0")}`;
    const entry: LogEntry = { id: logIdCounter++, time, level, msg };
    setLogs(prev => [...prev, entry]);
    pendingLogsRef.current.push(entry);
    if (logFlushTimerRef.current) clearTimeout(logFlushTimerRef.current);
    logFlushTimerRef.current = setTimeout(() => {
      flushLogsToServer(pendingLogsRef.current);
      pendingLogsRef.current = [];
    }, 500);
  }, [flushLogsToServer]);

  const clearLogs = useCallback(() => {
    setLogs([]);
    fetch("/api/log", { method: "DELETE" }).catch(() => {});
  }, []);

  const scrollPanels = useCallback(() => {
    if (sourcePanelRef.current) sourcePanelRef.current.scrollTop = sourcePanelRef.current.scrollHeight;
    if (translatedPanelRef.current) translatedPanelRef.current.scrollTop = translatedPanelRef.current.scrollHeight;
  }, []);

  const saveToFile = useCallback(() => {
    const data = chunksRef.current.filter(c => c.sourceText || c.translatedText);
    if (data.length === 0) return;

    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`;
    const filename = `transcription_${ts}.json`;

    const json = JSON.stringify(
      {
        meta: {
          timestamp: now.toISOString(),
          version: pkg.version,
          provider: providerRef.current,
          targetLanguage: targetLanguageRef.current,
          globalContext: globalContextRef.current,
          stats: tokenStatsRef.current,
        },
        transcript: data,
      },
      null,
      2
    );

    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const processAudioBlob = useCallback(async (blob: Blob) => {
    addLog("audio", `Processing batch...`);
    if (blob.size < 1000) return;

    const chunkId = `${Date.now()}-${Math.random()}`;
    setChunks(prev => [...prev, { id: chunkId, sourceText: "", translatedText: "", isTranslating: true }]);

    try {
      const arrayBuffer = await blob.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
      const base64 = btoa(binary);

      const context = chunksRef.current
        .filter(c => !c.isTranslating && c.sourceText)
        .slice(-3)
        .map(c => c.sourceText);

      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: base64,
          mimeType: blob.type || "audio/webm",
          provider: providerRef.current,
          groqKey:   groqKeyRef.current.trim()   || undefined,
          geminiKey: geminiKeyRef.current.trim() || undefined,
          context:   context.length > 0 ? context : undefined,
          globalContext: globalContextRef.current.trim() || undefined,
          targetLanguage: targetLanguageRef.current,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

      if (data.usage) {
        const u = data.usage;
        const prev = tokenStatsRef.current;
        tokenStatsRef.current = {
          sessionTotal:   (prev?.sessionTotal  ?? 0) + u.totalTokens,
          lastPrompt:     u.promptTokens,
          lastCompletion: u.completionTokens,
          lastBatch:      u.totalTokens,
          batchCount:     (prev?.batchCount    ?? 0) + 1,
          audioSeconds:   (prev?.audioSeconds  ?? 0) + batchSecRef.current,
          sessionStartMs: prev?.sessionStartMs ?? Date.now(),
        };
        setTokenStats(tokenStatsRef.current);
      }

      setChunks(prev => prev.map(c =>
        c.id === chunkId
          ? { ...c, sourceText: data.sourceText, translatedText: data.translatedText, detectedLanguage: data.detectedLanguage, isTranslating: false }
          : c
      ));
    } catch (err) {
      addLog("error", `API Error: ${err instanceof Error ? err.message : String(err)}`);
      setChunks(prev => prev.filter(c => c.id !== chunkId));
    }
  }, [addLog]);

  const flushRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  }, []);

  const scheduleBatch = useCallback(() => {
    if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);

    const batchMs = batchSecRef.current * 1000;
    const start = Date.now();
    setNextFlushIn(batchSecRef.current);

    countdownRef.current = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((batchMs - (Date.now() - start)) / 1000));
      setNextFlushIn(remaining);
    }, 250);

    batchTimerRef.current = setTimeout(() => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      flushRecording();
      if (isListeningRef.current) scheduleBatch();
    }, batchMs);
  }, [flushRecording]);

  const startRecorderSegment = useCallback((stream: MediaStream) => {
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find(m => MediaRecorder.isTypeSupported(m)) || "";
    const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 16000 });
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 100) processAudioBlob(new Blob([e.data], { type: mimeType || "audio/webm" }));
    };

    recorder.onstop = () => {
      if (isListeningRef.current) startRecorderSegment(stream);
      else setRecording(false);
    };

    recorder.start();
    setRecording(true);
  }, [processAudioBlob]);

  const startListening = useCallback(async () => {
    const needsKey = providerRef.current === "groq" ? !groqKeyRef.current.trim() : !geminiKeyRef.current.trim();
    if (needsKey) {
      setShowKeys(true);
      setError(`Please enter your ${providerRef.current === "groq" ? "Groq" : "Gemini"} API key.`);
      return;
    }

    setLogs([]);
    logIdCounter = 0;
    pendingLogsRef.current = [];
    tokenStatsRef.current = null;
    setTokenStats(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { autoGainControl: true } });
      isListeningRef.current = true;
      setIsListening(true);
      setError(null);
      startRecorderSegment(stream);
      scheduleBatch();
    } catch {
      setError("Microphone access denied.");
    }
  }, [startRecorderSegment, scheduleBatch]);

  const stopListening = useCallback(() => {
    isListeningRef.current = false;
    setIsListening(false);
    if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    setNextFlushIn(null);

    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
    recorder?.stream?.getTracks().forEach(t => t.stop());

    // Auto-save and purge logs on stop
    saveToFile();
    clearLogs();
  }, [saveToFile, clearLogs]);

  const clearAll = useCallback(() => {
    stopListening();
    setChunks([]);
  }, [stopListening]);

  // UI Derived Labels
  const lastChunkWithLang = [...chunks].reverse().find(c => c.detectedLanguage);
  const detectedLabel = lastChunkWithLang?.detectedLanguage || "Voice";
  const targetLabel = targetLanguage === "english" ? (lastChunkWithLang?.detectedLanguage?.toLowerCase() === "english" ? "Hindi" : "English") : "Hindi";
  
  return (
    <div className="min-h-screen flex flex-col bg-slate-900 text-slate-100 font-sans">
      <header className="flex items-center justify-between px-6 py-4 border-b border-slate-700 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-white">Universal Transcriber</h1>
          {isListening && (
            <span className="flex items-center gap-1.5 text-emerald-400 text-sm">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              {recording ? "Recording" : "Processing..."}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowKeys(v => !v)} className={`text-sm px-3 py-1.5 rounded border transition-colors ${showKeys ? "border-amber-500 text-amber-400 bg-amber-900/20" : "border-slate-600 text-slate-400 hover:text-slate-200 hover:border-slate-400"}`}>
            API Keys
          </button>
          <button onClick={() => setShowLogs(v => !v)} className={`text-sm px-3 py-1.5 rounded border transition-colors ${showLogs ? "border-sky-500 text-sky-400 bg-sky-900/30" : "border-slate-600 text-slate-400 hover:text-slate-200 hover:border-slate-400"}`}>
            Logs {logs.length > 0 && <span className="ml-1 text-xs opacity-60">{logs.length}</span>}
          </button>
          {ENABLE_DONATIONS && DONATION_URL && (
            <a
              href={DONATION_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm bg-rose-500/10 text-rose-400 hover:bg-rose-500 hover:text-white border border-rose-500/50 px-3 py-1.5 rounded transition-all flex items-center gap-1.5"
            >
              <span className="text-xs">❤</span> Support
            </a>
          )}
          <button onClick={clearAll} className="text-sm text-slate-400 hover:text-slate-200 px-3 py-1.5 rounded border border-slate-600 hover:border-slate-400 transition-colors">
            Clear All
          </button>
        </div>
      </header>

      {showKeys && (
        <div className="px-6 py-4 border-b border-amber-900/40 bg-amber-950/20 shrink-0">
          <div className="flex flex-wrap gap-6 items-end">
            <div className="flex flex-col gap-1.5 min-w-[280px] flex-1 max-w-sm">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Groq API Key</label>
              <input type={keysVisible ? "text" : "password"} value={groqKey} onChange={e => setGroqKey(e.target.value)} placeholder="gsk_..." className="w-full bg-slate-800 text-slate-200 border border-slate-600 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-amber-500" />
            </div>
            <div className="flex flex-col gap-1.5 min-w-[280px] flex-1 max-w-sm">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest">Gemini API Key</label>
              <input type={keysVisible ? "text" : "password"} value={geminiKey} onChange={e => setGeminiKey(e.target.value)} placeholder="AIza..." className="w-full bg-slate-800 text-slate-200 border border-slate-600 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-amber-500" />
            </div>
            <button onClick={() => setKeysVisible(v => !v)} className="text-xs text-slate-500 hover:text-slate-300 px-3 py-2 rounded border border-slate-700 hover:border-slate-500">
              {keysVisible ? "Hide" : "Show"}
            </button>
          </div>
        </div>
      )}

      {/* Global Context Section */}
      <div className="px-6 py-4 border-b border-slate-700 bg-slate-800/30">
        <label className="block text-[10px] font-semibold text-slate-500 uppercase tracking-[0.2em] mb-2">Speech Context (Topic, Speaker, Keywords)</label>
        <textarea
          value={globalContext}
          onChange={(e) => setGlobalContext(e.target.value)}
          placeholder="e.g., Spiritual lecture on Bhagavad Gita Chapter 2, speaker is explaining the soul..."
          className="w-full bg-slate-800/50 text-slate-200 border border-slate-700 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-sky-500/50 transition-colors resize-none h-20"
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3 border-b border-slate-700 shrink-0 bg-slate-800/50">
        <button onClick={isListening ? stopListening : startListening} className={`px-5 py-2 rounded-full font-medium text-sm transition-all shrink-0 ${isListening ? "bg-red-500 hover:bg-red-600 text-white" : "bg-emerald-500 hover:bg-emerald-600 text-white"}`}>
          {isListening ? "Stop Listening" : "Start Listening"}
        </button>

        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-400 shrink-0">Translate to:</span>
          <select value={targetLanguage} onChange={(e) => setTargetLanguage(e.target.value as "english" | "hindi")} className="bg-slate-800 text-slate-200 border border-slate-600 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-slate-400">
            <option value="english">English (Default)</option>
            <option value="hindi">Hindi</option>
          </select>
        </div>

        <div className="flex items-center gap-3 text-sm text-slate-400">
          <span className="shrink-0">Batch:</span>
          <input type="range" min={10} max={60} step={1} value={batchSec} onChange={(e) => setBatchSec(Number(e.target.value))} className="w-32 accent-emerald-400 cursor-pointer" />
          <span className="font-semibold text-slate-200">{batchSec}s</span>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-400 shrink-0">Provider:</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value as "gemini" | "groq")} disabled={isListening} className="bg-slate-800 text-slate-200 border border-slate-600 rounded px-2 py-1.5 text-sm disabled:opacity-40 focus:outline-none focus:border-slate-400">
            <option value="groq">Groq (Whisper + LLaMA)</option>
            <option value="gemini">Gemini 2.0 Flash Lite</option>
          </select>
        </div>

        {isListening && nextFlushIn !== null && (
          <div className="flex items-center gap-2 text-sm ml-auto font-mono text-emerald-400">
            Next batch in {nextFlushIn}s
          </div>
        )}
      </div>

      {tokenStats && (
        <div className="px-6 py-1.5 border-b border-slate-700 bg-slate-900/70 shrink-0 text-[10px] text-slate-500 uppercase tracking-widest flex gap-4">
          <span>Tokens: <span className="text-slate-300">{tokenStats.sessionTotal.toLocaleString()}</span></span>
          <span>Batches: <span className="text-slate-300">{tokenStats.batchCount}</span></span>
          <span>Audio: <span className="text-slate-300">{Math.floor(tokenStats.audioSeconds/60)}m {tokenStats.audioSeconds%60}s</span></span>
        </div>
      )}

      {error && (
        <div className="px-6 py-2 bg-red-900/40 border-b border-red-800 text-red-300 text-sm flex items-center justify-between shrink-0">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200 ml-4">✕</button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col border-r border-slate-700 overflow-hidden">
          <div className="px-4 py-2 bg-slate-800 border-b border-slate-700 shrink-0">
            <span className="text-xs font-semibold tracking-widest text-slate-400 uppercase">{detectedLabel} — Heard</span>
          </div>
          <div ref={sourcePanelRef} className="flex-1 overflow-y-auto p-4 space-y-2 scroll-smooth">
            {chunks.map(chunk => (
              <p key={chunk.id} className={`leading-relaxed ${chunk.isTranslating ? "text-slate-500 italic" : "text-slate-100"}`}>
                {chunk.sourceText || (chunk.isTranslating ? "Transcribing…" : "")}
              </p>
            ))}
          </div>
        </div>

        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-4 py-2 bg-slate-800 border-b border-slate-700 shrink-0">
            <span className="text-xs font-semibold tracking-widest text-slate-400 uppercase">{targetLabel} — Translation</span>
          </div>
          <div ref={translatedPanelRef} className="flex-1 overflow-y-auto p-4 space-y-2 text-emerald-50/90 scroll-smooth">
            {chunks.map(chunk => (
              <p key={chunk.id} className={`leading-relaxed ${chunk.isTranslating ? "text-slate-500 italic" : "text-slate-100"}`}>
                {chunk.translatedText || (chunk.isTranslating ? "Translating…" : "")}
              </p>
            ))}
          </div>
        </div>
      </div>

      {showLogs && (
        <div className="shrink-0 border-t border-slate-700 bg-slate-950 flex flex-col h-40">
          <div className="flex items-center justify-between px-4 py-1 border-b border-slate-800 shrink-0">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-widest">Debug Log</span>
            <button onClick={clearLogs} className="text-[10px] text-slate-600 hover:text-slate-400">Clear</button>
          </div>
          <div ref={logPanelRef} className="flex-1 overflow-y-auto p-2 font-mono text-[10px] space-y-0.5">
            {logs.map(entry => (
              <div key={entry.id} className="flex gap-2">
                <span className="text-slate-600 shrink-0">{entry.time}</span>
                <span className={`shrink-0 w-10 ${LOG_COLORS[entry.level]}`}>[{entry.level}]</span>
                <span className="text-slate-400">{entry.msg}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="px-6 py-2 border-t border-slate-700 bg-slate-800/20 text-[10px] text-slate-500 flex justify-between items-center shrink-0">
        <div className="flex items-center gap-4">
          <span>Point mic toward the speaker. Audio processed every {batchSec}s.</span>
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-slate-400">{onlineCount} user{onlineCount !== 1 ? "s" : ""} online</span>
          </div>
        </div>
        <div className="font-mono opacity-50">
          v{pkg.version}
        </div>
      </footer>
    </div>
  );
}
