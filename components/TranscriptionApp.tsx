"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type TranscriptChunk = {
  id: string;
  telugu: string;
  english: string;
  isTranslating: boolean;
  error?: boolean;
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

  const batchSecRef       = useRef(batchSec);
  const providerRef       = useRef(provider);
  const isListeningRef    = useRef(false);
  const mediaRecorderRef  = useRef<MediaRecorder | null>(null);
  const audioChunksRef    = useRef<Blob[]>([]);
  const batchTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef      = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingLogsRef    = useRef<LogEntry[]>([]);
  const logFlushTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const teluguPanelRef    = useRef<HTMLDivElement>(null);
  const englishPanelRef   = useRef<HTMLDivElement>(null);
  const logPanelRef       = useRef<HTMLDivElement>(null);

  useEffect(() => { batchSecRef.current = batchSec; }, [batchSec]);
  useEffect(() => { providerRef.current = provider; }, [provider]);

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
        body: JSON.stringify({ audio: base64, mimeType, provider: providerRef.current }),
      });

      addLog("api", `Response status: ${response.status}`);

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      addLog("api", `Telugu: "${(data.telugu || "").slice(0, 80)}" | English: "${(data.english || "").slice(0, 80)}"`);

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

  // ── Flush: stop current recording segment, process, restart recording ────
  const flushRecording = useCallback(() => {
    addLog("info", "Flush triggered — stopping MediaRecorder segment");
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      addLog("warn", "Recorder inactive at flush time");
      return;
    }
    recorder.stop(); // ondataavailable + onstop will fire → processAudioBlob
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
    }, batchMs);
  }, [flushRecording, addLog]);

  // ── Start a fresh MediaRecorder segment ──────────────────────────────────
  const startRecorderSegment = useCallback((stream: MediaStream) => {
    audioChunksRef.current = [];

    // Pick best supported format
    const mimeType = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ].find(m => MediaRecorder.isTypeSupported(m)) || "";

    addLog("audio", `Starting MediaRecorder — mimeType: "${mimeType || "browser default"}"`);

    // 16 kbps is plenty for speech; reduces file size ~8x vs default
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 16000,
    });
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        audioChunksRef.current.push(e.data);
        addLog("audio", `ondataavailable — chunk size: ${(e.data.size / 1024).toFixed(1)} KB`);
      }
    };

    recorder.onstop = () => {
      addLog("audio", `Recorder stopped — total chunks: ${audioChunksRef.current.length}`);
      if (audioChunksRef.current.length > 0) {
        const blob = new Blob(audioChunksRef.current, { type: mimeType || "audio/webm" });
        processAudioBlob(blob);
      }
      // Restart a new segment if still listening
      if (isListeningRef.current) {
        startRecorderSegment(stream);
        scheduleBatch();
      } else {
        setRecording(false);
      }
    };

    recorder.onerror = (e) => {
      addLog("error", `MediaRecorder error: ${JSON.stringify(e)}`);
    };

    recorder.start();
    setRecording(true);
    addLog("audio", "MediaRecorder started");
  }, [addLog, processAudioBlob, scheduleBatch]);

  // ── Start listening ───────────────────────────────────────────────────────
  const startListening = useCallback(async () => {
    setLogs([]);
    logIdCounter = 0;
    pendingLogsRef.current = [];
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
    if (recorder && recorder.state !== "inactive") {
      addLog("info", "Stopping recorder to flush final segment");
      recorder.stop(); // will trigger onstop → process remaining audio
    }

    // Stop mic tracks
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
              disabled={isListening}
              className="w-36 accent-emerald-400 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
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
