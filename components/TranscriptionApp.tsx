"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const LS_GROQ_KEY   = "tt_groq_key";
const LS_GEMINI_KEY = "tt_gemini_key";

type TranscriptChunk = {
  id: string;
  telugu: string;
  english: string;
  isTranslating: boolean;
  error?: boolean;
};

type TokenStats = {
  sessionTotal: number;      // cumulative tokens this session (LLaMA calls)
  lastPrompt: number;        // prompt tokens in last batch
  lastCompletion: number;    // completion tokens in last batch
  lastBatch: number;         // total tokens in last batch
  batchCount: number;        // number of batches processed
  audioSeconds: number;      // estimated audio seconds processed this session
  sessionStartMs: number;    // when session started
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
  const [tokenStats, setTokenStats]       = useState<TokenStats | null>(null);
  const tokenStatsRef                     = useRef<TokenStats | null>(null);
  const [groqKey, setGroqKey]             = useState("");
  const [geminiKey, setGeminiKey]         = useState("");
  const [showKeys, setShowKeys]           = useState(false);
  const [keysVisible, setKeysVisible]     = useState(false);
  const groqKeyRef                        = useRef("");
  const geminiKeyRef                      = useRef("");

  const batchSecRef       = useRef(batchSec);
  const providerRef       = useRef(provider);
  const isListeningRef    = useRef(false);
  const mediaRecorderRef  = useRef<MediaRecorder | null>(null);
  const batchTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingLogsRef    = useRef<LogEntry[]>([]);
  const logFlushTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const teluguPanelRef    = useRef<HTMLDivElement>(null);
  const englishPanelRef   = useRef<HTMLDivElement>(null);
  const logPanelRef       = useRef<HTMLDivElement>(null);

  useEffect(() => {
    batchSecRef.current = batchSec;
    if (isListeningRef.current) {
      addLog("info", `Batch interval changed to ${batchSec}s — rescheduling timer`);
      scheduleBatch();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchSec]);
  useEffect(() => { providerRef.current = provider; }, [provider]);

  // ── Load keys from localStorage on mount ─────────────────────────────────
  useEffect(() => {
    setGroqKey(localStorage.getItem(LS_GROQ_KEY)   ?? "");
    setGeminiKey(localStorage.getItem(LS_GEMINI_KEY) ?? "");
  }, []);

  // ── Persist keys to localStorage and keep refs in sync ───────────────────
  useEffect(() => { groqKeyRef.current = groqKey;     localStorage.setItem(LS_GROQ_KEY,   groqKey);   }, [groqKey]);
  useEffect(() => { geminiKeyRef.current = geminiKey; localStorage.setItem(LS_GEMINI_KEY, geminiKey); }, [geminiKey]);

  // ── Logging ──────────────────────────────────────────────────────────────
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
    setTimeout(() => {
      if (logPanelRef.current) logPanelRef.current.scrollTop = logPanelRef.current.scrollHeight;
    }, 0);
  }, [flushLogsToServer]);

  const clearLogs = useCallback(() => {
    setLogs([]);
    fetch("/api/log", { method: "DELETE" }).catch(() => {});
  }, []);

  // ── Scroll panels ─────────────────────────────────────────────────────────
  const scrollPanels = useCallback(() => {
    if (teluguPanelRef.current) teluguPanelRef.current.scrollTop = teluguPanelRef.current.scrollHeight;
    if (englishPanelRef.current) englishPanelRef.current.scrollTop = englishPanelRef.current.scrollHeight;
  }, []);

  // ── Send recorded audio to Gemini ─────────────────────────────────────────
  const processAudioBlob = useCallback(async (blob: Blob) => {
    addLog("audio", `Processing audio blob — size: ${(blob.size / 1024).toFixed(1)} KB, type: ${blob.type}`);

    if (blob.size < 1000) {
      addLog("warn", "Audio blob too small (<1KB) — likely silence, skipping");
      return;
    }

    const chunkId = `${Date.now()}-${Math.random()}`;
    setChunks(prev => {
      const updated = [...prev, { id: chunkId, telugu: "", english: "", isTranslating: true }];
      return updated.length > 200 ? updated.slice(-200) : updated;
    });
    scrollPanels();

    try {
      // Convert blob to base64
      const arrayBuffer = await blob.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
      const base64 = btoa(binary);
      const mimeType = blob.type || "audio/webm";

      addLog("api", `POST /api/transcribe — ${(base64.length / 1024).toFixed(1)} KB base64`);

      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: base64,
          mimeType,
          provider: providerRef.current,
          groqKey:   groqKeyRef.current.trim()   || undefined,
          geminiKey: geminiKeyRef.current.trim() || undefined,
        }),
      });

      addLog("api", `Response status: ${response.status}`);

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      addLog("api", `Telugu: "${(data.telugu || "").slice(0, 80)}" | English: "${(data.english || "").slice(0, 80)}"`);

      if (data.usage) {
        const u = data.usage;
        const prev = tokenStatsRef.current;
        const updated: TokenStats = {
          sessionTotal:   (prev?.sessionTotal  ?? 0) + u.totalTokens,
          lastPrompt:     u.promptTokens,
          lastCompletion: u.completionTokens,
          lastBatch:      u.totalTokens,
          batchCount:     (prev?.batchCount    ?? 0) + 1,
          audioSeconds:   (prev?.audioSeconds  ?? 0) + batchSecRef.current,
          sessionStartMs: prev?.sessionStartMs ?? Date.now(),
        };
        tokenStatsRef.current = updated;
        setTokenStats(updated);
        const elapsedMin = (Date.now() - updated.sessionStartMs) / 60_000;
        const tpm = elapsedMin > 0 ? Math.round(updated.sessionTotal / elapsedMin) : 0;
        addLog("api", `Tokens — prompt: ${u.promptTokens}, completion: ${u.completionTokens}, batch: ${u.totalTokens} | session: ${updated.sessionTotal.toLocaleString()} | ~${tpm} tok/min`);
      }

      if (!data.telugu && !data.english) {
        addLog("warn", "Gemini returned empty — no speech detected in audio");
        setChunks(prev => prev.filter(c => c.id !== chunkId));
        return;
      }

      setChunks(prev => prev.map(c =>
        c.id === chunkId
          ? { ...c, telugu: data.telugu || "", english: data.english || "", isTranslating: false }
          : c
      ));
      scrollPanels();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog("error", `Transcription failed: ${msg}`);
      // Remove the placeholder chunk — don't pollute transcript with error markers
      setChunks(prev => prev.filter(c => c.id !== chunkId));
    }
  }, [addLog, scrollPanels]);

  // ── Flush: stop current recorder (delivers complete valid file), then restart
  const flushRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") {
      addLog("warn", `Flush skipped — recorder state: ${recorder?.state ?? "null"}`);
      return;
    }
    addLog("info", "Flush triggered — stop/restart recorder (complete file per batch)");
    // Stopping delivers a complete, valid WebM file via ondataavailable + onstop
    recorder.stop();
  }, [addLog]);

  // ── Schedule batch timer ──────────────────────────────────────────────────
  const scheduleBatch = useCallback(() => {
    if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);

    const batchMs = batchSecRef.current * 1000;
    const start = Date.now();
    setNextFlushIn(batchSecRef.current);
    addLog("info", `Batch timer scheduled — ${batchSecRef.current}s`);

    countdownRef.current = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((batchMs - (Date.now() - start)) / 1000));
      setNextFlushIn(remaining);
    }, 250);

    batchTimerRef.current = setTimeout(() => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      addLog("info", "Batch timer fired");
      flushRecording();
      if (isListeningRef.current) scheduleBatch(); // reschedule next batch
    }, batchMs);
  }, [flushRecording, addLog]);

  // ── Start one continuous MediaRecorder for the whole session ─────────────
  const startRecorderSegment = useCallback((stream: MediaStream) => {
    const mimeType = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ].find(m => MediaRecorder.isTypeSupported(m)) || "";

    addLog("audio", `Starting MediaRecorder — mimeType: "${mimeType || "browser default"}"`);

    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 16000,
    });
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size < 100) {
        addLog("warn", `ondataavailable — skipped tiny chunk (${e.data?.size ?? 0} bytes)`);
        return;
      }
      addLog("audio", `ondataavailable — ${(e.data.size / 1024).toFixed(1)} KB`);
      const blob = new Blob([e.data], { type: mimeType || "audio/webm" });
      processAudioBlob(blob);
    };

    recorder.onstop = () => {
      if (isListeningRef.current) {
        // Batch flush — restart immediately for the next batch
        addLog("audio", "Recorder stopped (batch flush) — restarting for next batch");
        startRecorderSegment(stream);
      } else {
        addLog("audio", "Recorder stopped (session end)");
        setRecording(false);
      }
    };

    recorder.onerror = (e) => {
      addLog("error", `MediaRecorder error: ${JSON.stringify(e)}`);
    };

    recorder.start();
    setRecording(true);
    addLog("audio", "MediaRecorder started (stop/restart per batch — complete files)");
  }, [addLog, processAudioBlob]);

  // ── Start listening ───────────────────────────────────────────────────────
  const startListening = useCallback(async () => {
    // Check the active provider has a key (custom or server-side)
    const needsKey = providerRef.current === "groq"
      ? !groqKeyRef.current.trim()
      : !geminiKeyRef.current.trim();

    if (needsKey) {
      setShowKeys(true);
      setError(`Please enter your ${providerRef.current === "groq" ? "Groq" : "Gemini"} API key to continue.`);
      return;
    }

    setLogs([]);
    logIdCounter = 0;
    pendingLogsRef.current = [];
    tokenStatsRef.current = null;
    setTokenStats(null);
    fetch("/api/log", { method: "DELETE" }).catch(() => {});

    addLog("info", "Requesting microphone access...");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
        },
      });
      addLog("info", `Microphone granted — tracks: ${stream.getAudioTracks().map(t => t.label).join(", ")}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog("error", `Microphone access failed: ${msg}`);
      setError("Microphone access denied. Please allow microphone permission.");
      return;
    }

    isListeningRef.current = true;
    setIsListening(true);
    setError(null);
    addLog("info", `Started recording — provider: ${providerRef.current}, batch: ${batchSecRef.current}s`);

    startRecorderSegment(stream);
    scheduleBatch(); // kick off the first timer
  }, [addLog, startRecorderSegment, scheduleBatch]);

  // ── Stop listening ────────────────────────────────────────────────────────
  const stopListening = useCallback(() => {
    addLog("info", "Stop Listening pressed");
    isListeningRef.current = false;
    setIsListening(false);
    if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    setNextFlushIn(null);

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      recorder.stop(); // delivers final audio chunk via ondataavailable, then onstop fires
      addLog("info", "Final stop on session end");
    }

    recorder?.stream?.getTracks().forEach(t => { t.stop(); addLog("audio", `Track stopped: ${t.label}`); });
  }, [addLog]);

  const clearAll = useCallback(() => {
    stopListening();
    setChunks([]);
  }, [stopListening]);

  // ── UI ────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col bg-slate-900 text-slate-100">

      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-slate-700 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-white">Telugu Transcriber</h1>
          {isListening && (
            <span className="flex items-center gap-1.5 text-emerald-400 text-sm">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse-dot" />
              {recording ? "Recording" : "Processing..."}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowKeys(v => !v)}
            className={`text-sm px-3 py-1.5 rounded border transition-colors ${
              showKeys
                ? "border-amber-500 text-amber-400 bg-amber-900/20"
                : "border-slate-600 text-slate-400 hover:text-slate-200 hover:border-slate-400"
            }`}
          >
            API Keys
            {(groqKey.trim() || geminiKey.trim()) && (
              <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 align-middle" title="Custom keys active" />
            )}
          </button>
          <button
            onClick={() => setShowLogs(v => !v)}
            className={`text-sm px-3 py-1.5 rounded border transition-colors ${
              showLogs
                ? "border-sky-500 text-sky-400 bg-sky-900/30"
                : "border-slate-600 text-slate-400 hover:text-slate-200 hover:border-slate-400"
            }`}
          >
            Logs {logs.length > 0 && <span className="ml-1 text-xs opacity-60">{logs.length}</span>}
          </button>
          <button
            onClick={clearAll}
            className="text-sm text-slate-400 hover:text-slate-200 px-3 py-1.5 rounded border border-slate-600 hover:border-slate-400 transition-colors"
          >
            Clear All
          </button>
        </div>
      </header>

      {/* API Keys panel */}
      {showKeys && (
        <div className="px-6 py-4 border-b border-amber-900/40 bg-amber-950/20 shrink-0">
          <div className="flex flex-wrap gap-6 items-end">
            <div className="flex flex-col gap-1.5 min-w-[280px] flex-1 max-w-sm">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                Groq API Key
                <span className="ml-2 font-normal normal-case text-slate-600">
                  {groqKey.trim() ? "— custom key active" : "— using server key"}
                </span>
              </label>
              <div className="relative">
                <input
                  type={keysVisible ? "text" : "password"}
                  value={groqKey}
                  onChange={e => setGroqKey(e.target.value)}
                  placeholder="gsk_… (leave blank to use server key)"
                  spellCheck={false}
                  className="w-full bg-slate-800 text-slate-200 border border-slate-600 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-amber-500 placeholder:text-slate-600"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5 min-w-[280px] flex-1 max-w-sm">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                Gemini API Key
                <span className="ml-2 font-normal normal-case text-slate-600">
                  {geminiKey.trim() ? "— custom key active" : "— using server key"}
                </span>
              </label>
              <input
                type={keysVisible ? "text" : "password"}
                value={geminiKey}
                onChange={e => setGeminiKey(e.target.value)}
                placeholder="AIza… (leave blank to use server key)"
                spellCheck={false}
                className="w-full bg-slate-800 text-slate-200 border border-slate-600 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-amber-500 placeholder:text-slate-600"
              />
            </div>

            <div className="flex flex-col gap-2 shrink-0">
              <button
                onClick={() => setKeysVisible(v => !v)}
                className="text-xs text-slate-500 hover:text-slate-300 px-3 py-2 rounded border border-slate-700 hover:border-slate-500 transition-colors"
              >
                {keysVisible ? "Hide" : "Show"}
              </button>
              {(groqKey.trim() || geminiKey.trim()) && (
                <button
                  onClick={() => { setGroqKey(""); setGeminiKey(""); }}
                  className="text-xs text-red-500 hover:text-red-300 px-3 py-2 rounded border border-red-900 hover:border-red-700 transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
          <p className="mt-2 text-[11px] text-slate-600">
            Keys are saved in your browser only (localStorage) and sent directly to the API — never stored on the server.
          </p>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3 border-b border-slate-700 shrink-0 bg-slate-800/50">
        <button
          onClick={isListening ? stopListening : startListening}
          className={`px-5 py-2 rounded-full font-medium text-sm transition-all shrink-0 ${
            isListening ? "bg-red-500 hover:bg-red-600 text-white" : "bg-emerald-500 hover:bg-emerald-600 text-white"
          }`}
        >
          {isListening ? "Stop Listening" : "Start Listening"}
        </button>

        {/* Provider selector */}
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-400 shrink-0">Provider:</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as "gemini" | "groq")}
            disabled={isListening}
            className="bg-slate-800 text-slate-200 border border-slate-600 rounded px-2 py-1.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer focus:outline-none focus:border-slate-400"
          >
            <option value="groq">Groq (Whisper + LLaMA)</option>
            <option value="gemini">Gemini 2.0 Flash Lite</option>
          </select>
        </div>

        {/* Batch interval slider */}
        <div className="flex items-center gap-3 text-sm text-slate-400">
          <span className="shrink-0">Translate every</span>
          <div className="relative flex items-center pb-4">
            <input
              type="range" min={10} max={60} step={1}
              value={batchSec}
              onChange={(e) => setBatchSec(Number(e.target.value))}
              className="w-36 accent-emerald-400 cursor-pointer"
            />
            <div className="absolute bottom-0 left-0 right-0 flex justify-between px-0.5 pointer-events-none">
              {[10, 20, 30, 40, 50, 60].map(v => (
                <span key={v} className="text-[9px] text-slate-600">{v}s</span>
              ))}
            </div>
          </div>
          <span className="font-semibold text-slate-200 w-12 shrink-0">
            {batchSec < 60 ? `${batchSec}s` : "1 min"}
          </span>
        </div>

        {/* Countdown + manual trigger */}
        {isListening && nextFlushIn !== null && (
          <div className="flex items-center gap-2 text-sm ml-auto">
            <span className="text-slate-500">Next in</span>
            <span className="font-mono text-emerald-400 font-semibold tabular-nums w-7 text-right">{nextFlushIn}s</span>
            <button
              onClick={() => {
                if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
                if (countdownRef.current) clearInterval(countdownRef.current);
                addLog("info", "Manual flush triggered");
                flushRecording();
              }}
              className="text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 px-2 py-1 rounded transition-colors"
            >
              Now
            </button>
          </div>
        )}
      </div>

      {/* Token usage panel */}
      {tokenStats && (() => {
        const s = tokenStats;

        // ── Actuals ──────────────────────────────────────────────────────────
        const elapsedMin   = (Date.now() - s.sessionStartMs) / 60_000;
        const tpm          = elapsedMin > 0 ? Math.round(s.sessionTotal / elapsedMin) : 0;
        const tpmPct       = Math.min(100, (tpm / 6000) * 100);
        const tpdPct       = Math.min(100, (s.sessionTotal / 1_000_000) * 100);
        const audioMin     = Math.floor(s.audioSeconds / 60);
        const audioSec     = s.audioSeconds % 60;
        const audioDayPct  = Math.min(100, (s.audioSeconds / 28800) * 100);
        const tpmColor     = tpmPct > 80 ? "bg-red-500" : tpmPct > 50 ? "bg-yellow-400" : "bg-sky-500";
        const tpdColor     = tpdPct > 80 ? "bg-red-500" : tpdPct > 50 ? "bg-yellow-400" : "bg-emerald-500";
        const audioColor   = audioDayPct > 80 ? "bg-red-500" : audioDayPct > 50 ? "bg-yellow-400" : "bg-emerald-500";

        // ── Projections (recalculate whenever batchSec changes) ───────────
        const avgTokPerBatch  = s.batchCount > 0 ? s.sessionTotal / s.batchCount : null;
        // projected tokens/min at current batch size
        const projTpm         = avgTokPerBatch != null ? Math.round((avgTokPerBatch / batchSec) * 60) : null;
        // projected tokens for a full 2-hour session
        const batchesIn2Hr    = (2 * 3600) / batchSec;
        const projSession2hr  = avgTokPerBatch != null ? Math.round(avgTokPerBatch * batchesIn2Hr) : null;
        // how many minutes until TPM limit (6000) is hit — null if never
        const minsToTpmLimit  = projTpm != null && projTpm > 0 ? Math.round((6000 / projTpm) * 60) : null;
        // how many sessions (2 hr) until daily token limit (1M) is hit
        const sessionsToTpd   = projSession2hr != null && projSession2hr > 0 ? (1_000_000 / projSession2hr).toFixed(1) : null;
        const projTpmColor    = projTpm != null && projTpm > 4800 ? "text-red-400" : projTpm != null && projTpm > 3000 ? "text-yellow-400" : "text-emerald-400";

        return (
          <div className="px-6 py-2.5 border-b border-slate-700 bg-slate-900/70 shrink-0 space-y-2">

            {/* ── Row 1: actuals ── */}
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-xs">

              {/* Last batch */}
              <div className="flex flex-col gap-0.5 min-w-[130px]">
                <span className="text-slate-500 uppercase tracking-widest font-semibold text-[10px]">Last Batch</span>
                <span className="font-mono text-slate-200">
                  <span className="text-slate-400">in </span><span className="text-sky-400">{s.lastPrompt.toLocaleString()}</span>
                  <span className="text-slate-600"> + </span>
                  <span className="text-slate-400">out </span><span className="text-emerald-400">{s.lastCompletion.toLocaleString()}</span>
                  <span className="text-slate-600"> = </span>
                  <span className="text-white font-bold">{s.lastBatch.toLocaleString()}</span>
                  <span className="text-slate-500"> tok</span>
                </span>
              </div>

              {/* Session total vs daily limit */}
              <div className="flex flex-col gap-0.5 min-w-[160px]">
                <span className="text-slate-500 uppercase tracking-widest font-semibold text-[10px]">Daily tokens (LLaMA)</span>
                <div className="flex items-center gap-2">
                  <div className="w-20 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${tpdColor}`} style={{ width: `${tpdPct}%` }} />
                  </div>
                  <span className="font-mono text-slate-300">
                    <span className="text-white">{s.sessionTotal.toLocaleString()}</span>
                    <span className="text-slate-600"> / 1M</span>
                  </span>
                  <span className="text-emerald-400">{(1_000_000 - s.sessionTotal).toLocaleString()} left</span>
                </div>
              </div>

              {/* TPM rate */}
              <div className="flex flex-col gap-0.5 min-w-[160px]">
                <span className="text-slate-500 uppercase tracking-widest font-semibold text-[10px]">Rate (limit: 6,000/min)</span>
                <div className="flex items-center gap-2">
                  <div className="w-20 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${tpmColor}`} style={{ width: `${tpmPct}%` }} />
                  </div>
                  <span className="font-mono text-slate-300">
                    ~<span className={tpmPct > 80 ? "text-red-400" : tpmPct > 50 ? "text-yellow-400" : "text-white"}>{tpm.toLocaleString()}</span>
                    <span className="text-slate-600"> tok/min</span>
                  </span>
                </div>
              </div>

              {/* Whisper audio */}
              <div className="flex flex-col gap-0.5 min-w-[180px]">
                <span className="text-slate-500 uppercase tracking-widest font-semibold text-[10px]">Audio (Whisper daily: 8 hrs)</span>
                <div className="flex items-center gap-2">
                  <div className="w-20 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${audioColor}`} style={{ width: `${audioDayPct}%` }} />
                  </div>
                  <span className="font-mono text-slate-300">
                    <span className="text-white">{audioMin}m {String(audioSec).padStart(2,"0")}s</span>
                    <span className="text-slate-600"> this session</span>
                  </span>
                </div>
              </div>

              {/* Batch count */}
              <div className="flex flex-col gap-0.5 justify-end ml-auto text-right">
                <span className="text-slate-600">{s.batchCount} batch{s.batchCount !== 1 ? "es" : ""} processed</span>
              </div>

            </div>

            {/* ── Row 2: projections based on current batch size ── */}
            {avgTokPerBatch != null && (
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] pt-1 border-t border-slate-800 text-slate-500">
                <span className="text-slate-600 font-semibold uppercase tracking-widest text-[10px] shrink-0 self-center">
                  Projected @ {batchSec}s batches
                </span>
                <span>
                  ~<span className="text-slate-300 font-mono">{avgTokPerBatch.toFixed(0)}</span> tok/batch
                </span>
                <span>
                  ~<span className={`font-mono ${projTpmColor}`}>{projTpm?.toLocaleString()}</span> tok/min
                  {projTpm != null && projTpm >= 6000 && (
                    <span className="text-red-400 ml-1 font-semibold">⚠ exceeds TPM limit</span>
                  )}
                  {projTpm != null && projTpm < 6000 && minsToTpmLimit != null && (
                    <span className="text-slate-600 ml-1">({Math.floor(minsToTpmLimit / 60)}h {minsToTpmLimit % 60}m to TPM limit)</span>
                  )}
                </span>
                <span>
                  ~<span className="text-slate-300 font-mono">{projSession2hr?.toLocaleString()}</span> tok for 2-hr session
                  {sessionsToTpd && (
                    <span className="text-slate-600 ml-1">({sessionsToTpd} sessions to daily limit)</span>
                  )}
                </span>
              </div>
            )}

          </div>
        );
      })()}

      {/* Error banner */}
      {error && (
        <div className="px-6 py-2 bg-red-900/40 border-b border-red-800 text-red-300 text-sm flex items-center justify-between shrink-0">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200 ml-4">✕</button>
        </div>
      )}

      {/* Two-column transcript */}
      <div className="flex flex-1 overflow-hidden">
        {/* Telugu column */}
        <div className="flex-1 flex flex-col border-r border-slate-700 overflow-hidden">
          <div className="px-4 py-2 bg-slate-800 border-b border-slate-700 shrink-0">
            <span className="text-xs font-semibold tracking-widest text-slate-400 uppercase">Telugu — Heard</span>
          </div>
          <div ref={teluguPanelRef} className="transcript-panel flex-1 overflow-y-auto p-4 space-y-2">
            {chunks.map(chunk => (
              <p key={chunk.id} className={`leading-relaxed ${chunk.isTranslating ? "text-slate-500 italic" : "text-slate-100"}`}>
                {chunk.telugu || (chunk.isTranslating ? "Transcribing…" : "")}
              </p>
            ))}
            {!chunks.length && (
              <p className="text-slate-600 italic text-sm">Telugu speech will appear here...</p>
            )}
          </div>
        </div>

        {/* English column */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-4 py-2 bg-slate-800 border-b border-slate-700 shrink-0">
            <span className="text-xs font-semibold tracking-widest text-slate-400 uppercase">English — Translation</span>
          </div>
          <div ref={englishPanelRef} className="transcript-panel flex-1 overflow-y-auto p-4 space-y-2">
            {chunks.map(chunk => (
              <p key={chunk.id} className={`leading-relaxed ${chunk.error ? "text-red-400" : chunk.isTranslating ? "text-slate-500 italic" : "text-slate-100"}`}>
                {chunk.english || (chunk.isTranslating ? "Translating…" : "")}
              </p>
            ))}
            {!chunks.length && (
              <p className="text-slate-600 italic text-sm">English translation will appear here...</p>
            )}
          </div>
        </div>
      </div>

      {/* Log panel */}
      {showLogs && (
        <div className="shrink-0 border-t border-slate-700 bg-slate-950 flex flex-col" style={{ height: "220px" }}>
          <div className="flex items-center justify-between px-4 py-1.5 border-b border-slate-800 shrink-0">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
              Debug Log ({logs.length} entries)
            </span>
            <button
              onClick={clearLogs}
              className="text-xs text-slate-500 hover:text-slate-300 px-2 py-0.5 rounded border border-slate-700 hover:border-slate-500 transition-colors"
            >
              Clear Logs
            </button>
          </div>
          <div ref={logPanelRef} className="flex-1 overflow-y-auto p-2 font-mono text-xs space-y-0.5">
            {logs.length === 0 && (
              <p className="text-slate-700 italic p-1">No logs yet. Start listening to see events.</p>
            )}
            {logs.map(entry => (
              <div key={entry.id} className="flex gap-2 leading-5">
                <span className="text-slate-600 shrink-0">{entry.time}</span>
                <span className={`shrink-0 w-12 ${LOG_COLORS[entry.level]}`}>[{entry.level}]</span>
                <span className="text-slate-300 break-all">{entry.msg}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="px-6 py-2 border-t border-slate-700 text-xs text-slate-600 shrink-0">
        Point mic toward the speaker. Audio is sent to Gemini every {batchSec}s for transcription.
      </footer>
    </div>
  );
}
