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
  const [showSidebar, setShowSidebar]     = useState(true);
  const [recording, setRecording]         = useState(false);
  const [provider, setProvider]           = useState<"gemini" | "groq">("groq");
  const [targetLanguage, setTargetLanguage] = useState<"english" | "hindi">("english");
  const [audioSource, setAudioSource]     = useState<"mic" | "system">("mic");
  const [globalContext, setGlobalContext] = useState("");
  const [onlineCount, setOnlineCount]     = useState(1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [auditReport, setAuditReport]     = useState<any>(null);
  const [saving, setSaving]               = useState(false);
  const tokenStatsRef                     = useRef<TokenStats | null>(null);
  const [groqKey, setGroqKey]             = useState("");
  const [geminiKey, setGeminiKey]         = useState("");
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

  const saveToFile = useCallback(async () => {
    const data = chunksRef.current.filter(c => c.sourceText || c.translatedText);
    if (data.length === 0) return;

    setSaving(true);
    addLog("info", "Saving session and performing auto-audit...");

    const payload = {
      meta: {
        timestamp: new Date().toISOString(),
        version: pkg.version,
        provider: providerRef.current,
        targetLanguage: targetLanguageRef.current,
        globalContext: globalContextRef.current,
        stats: tokenStatsRef.current,
      },
      transcript: data,
      geminiKey: geminiKeyRef.current.trim() || undefined,
    };

    try {
      const res = await fetch("/api/sessions/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Save failed");
      
      if (result.auditReport) {
        setAuditReport(result.auditReport);
        addLog("info", `Session saved to server: ${result.filename}. Auto-audit complete.`);
      } else {
        addLog("info", `Session saved to server: ${result.filename}`);
      }

      // Also trigger a browser download for the user's convenience
      const blob = new Blob([JSON.stringify({ ...payload, auditReport: result.auditReport }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `session_${new Date().getTime()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

    } catch (err) {
      addLog("error", `Failed to save session: ${err}`);
    } finally {
      setSaving(false);
    }
  }, [addLog]);

  const stopListening = useCallback(() => {
    isListeningRef.current = false;
    setIsListening(false);
    if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    setNextFlushIn(null);

    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
    recorder?.stream?.getTracks().forEach(t => t.stop());

    addLog("info", "Listening stopped. Finalizing session...");

    // Wait for last API calls to settle
    setTimeout(() => {
      saveToFile();
    }, 2500);
  }, [saveToFile, addLog]);

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
      setShowSidebar(true);
      setError(`Please enter your ${providerRef.current === "groq" ? "Groq" : "Gemini"} API key.`);
      return;
    }

    setLogs([]);
    logIdCounter = 0;
    pendingLogsRef.current = [];
    tokenStatsRef.current = null;
    setAuditReport(null);

    try {
      let stream: MediaStream;
      if (audioSource === "system") {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
        const audioTracks = displayStream.getAudioTracks();
        if (audioTracks.length === 0) {
          displayStream.getTracks().forEach(t => t.stop());
          throw new Error("No audio shared. Please ensure you check 'Share system audio' or 'Share tab audio' when selecting the screen.");
        }
        stream = new MediaStream(audioTracks);

        // Auto-stop if user clicks "Stop sharing" in the browser UI
        displayStream.getVideoTracks()[0]?.addEventListener("ended", () => {
          stopListening();
        });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { autoGainControl: true } });
      }

      isListeningRef.current = true;
      setIsListening(true);
      setError(null);
      startRecorderSegment(stream);
      scheduleBatch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes("NotAllowedError") ? "Audio access denied or cancelled." : msg);
    }
  }, [audioSource, startRecorderSegment, scheduleBatch, stopListening]);

  const clearAll = useCallback(() => {
    stopListening();
    setChunks([]);
    setAuditReport(null);
    clearLogs();
  }, [stopListening, clearLogs]);

  const clearTranscript = useCallback(() => {
    setChunks([]);
    setAuditReport(null);
  }, []);

  const scrollPanels = useCallback(() => {
    // Force scroll to bottom for both panels
    const scroll = (ref: React.RefObject<HTMLDivElement | null>) => {
      if (ref.current) {
        ref.current.scrollTop = ref.current.scrollHeight;
      }
    };
    
    // Call multiple times to handle slow rendering or layout shifts
    scroll(sourcePanelRef);
    scroll(translatedPanelRef);
    setTimeout(() => { scroll(sourcePanelRef); scroll(translatedPanelRef); }, 50);
    setTimeout(() => { scroll(sourcePanelRef); scroll(translatedPanelRef); }, 150);
  }, []);

  useEffect(() => {
    if (chunks.length > 0) {
      scrollPanels();
    }
  }, [chunks, scrollPanels]);

  // UI Derived Labels
  const lastChunkWithLang = [...chunks].reverse().find(c => c.detectedLanguage);
  const detectedLabel = lastChunkWithLang?.detectedLanguage || "Voice";
  const targetLabel = targetLanguage === "english" ? (lastChunkWithLang?.detectedLanguage?.toLowerCase() === "english" ? "Hindi" : "English") : "Hindi";
  
  return (
    <div className="min-h-screen flex bg-slate-900 text-slate-100 font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className={`transition-all duration-300 border-r border-slate-800 bg-slate-900/50 flex flex-col shrink-0 ${showSidebar ? "w-80" : "w-0 overflow-hidden border-none"}`}>
        <div className="p-6 flex flex-col gap-8 h-full overflow-y-auto custom-scrollbar">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">Settings</h2>
            <button onClick={() => setShowSidebar(false)} className="text-slate-500 hover:text-white lg:hidden">✕</button>
          </div>

          <section className="space-y-6">
            <div className="space-y-3">
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">API Keys</label>
              <div className="space-y-2">
                <input type={keysVisible ? "text" : "password"} value={groqKey} onChange={e => setGroqKey(e.target.value)} placeholder="Groq Key" className="w-full bg-slate-800/50 text-slate-200 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:border-sky-500/50" />
                <input type={keysVisible ? "text" : "password"} value={geminiKey} onChange={e => setGeminiKey(e.target.value)} placeholder="Gemini Key" className="w-full bg-slate-800/50 text-slate-200 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:border-sky-500/50" />
                <button onClick={() => setKeysVisible(v => !v)} className="text-[10px] text-slate-500 hover:text-slate-300 flex items-center gap-1">
                  {keysVisible ? "Hide Keys" : "Show Keys"}
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Audio Configuration</label>
              <div className="space-y-4">
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] text-slate-400">Source</span>
                  <select value={audioSource} onChange={(e) => setAudioSource(e.target.value as "mic" | "system")} disabled={isListening} className="w-full bg-slate-800/50 text-slate-200 border border-slate-700 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-sky-500/50">
                    <option value="mic">Microphone</option>
                    <option value="system">System Audio</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] text-slate-400">Provider</span>
                  <select value={provider} onChange={(e) => setProvider(e.target.value as "gemini" | "groq")} disabled={isListening} className="w-full bg-slate-800/50 text-slate-200 border border-slate-700 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-sky-500/50">
                    <option value="groq">Groq (Whisper + LLaMA)</option>
                    <option value="gemini">Gemini 2.0 Flash Lite</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] text-slate-400">Batch Size ({batchSec}s)</span>
                  <input type="range" min={10} max={60} step={1} value={batchSec} onChange={(e) => setBatchSec(Number(e.target.value))} className="w-full accent-sky-500" />
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Speech Context</label>
              <textarea
                value={globalContext}
                onChange={(e) => setGlobalContext(e.target.value)}
                placeholder="Topic, speakers, keywords..."
                className="w-full bg-slate-800/50 text-slate-200 border border-slate-700 rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-sky-500/50 h-32 resize-none"
              />
            </div>
          </section>

          <footer className="mt-auto pt-6 border-t border-slate-800 space-y-4">
            <div className="flex items-center gap-2 text-[10px] text-slate-500">
              <span className={`w-1.5 h-1.5 rounded-full ${onlineCount > 0 ? "bg-emerald-500" : "bg-slate-700"}`} />
              {onlineCount} user{onlineCount !== 1 ? "s" : ""} online
            </div>
            <div className="text-[10px] text-slate-600 font-mono">
              v{pkg.version}
            </div>
          </footer>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/80 backdrop-blur-md sticky top-0 z-10">
          <div className="flex items-center gap-4">
            {!showSidebar && (
              <button onClick={() => setShowSidebar(true)} className="p-2 -ml-2 text-slate-400 hover:text-white transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
              </button>
            )}
            <div className="flex flex-col">
              <h1 className="text-sm font-bold text-white flex items-center gap-2">
                Universal Transcriber
                {isListening && <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />}
              </h1>
              {isListening && nextFlushIn !== null && (
                <span className="text-[10px] text-emerald-400 font-mono">Processing in {nextFlushIn}s</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center bg-slate-800 rounded-lg p-1 mr-2 border border-slate-700">
              <button onClick={() => setTargetLanguage("english")} className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${targetLanguage === "english" ? "bg-slate-700 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"}`}>ENGLISH</button>
              <button onClick={() => setTargetLanguage("hindi")} className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${targetLanguage === "hindi" ? "bg-slate-700 text-white shadow-sm" : "text-slate-400 hover:text-slate-200"}`}>HINDI</button>
            </div>

            <button onClick={isListening ? stopListening : startListening} className={`px-4 py-1.5 rounded-lg font-bold text-[10px] uppercase tracking-wider transition-all shadow-lg shadow-black/20 ${isListening ? "bg-rose-500 hover:bg-rose-600 text-white" : "bg-emerald-500 hover:bg-emerald-600 text-white"}`}>
              {isListening ? "Stop" : "Start"}
            </button>

            <div className="h-4 w-[1px] bg-slate-800 mx-1" />

            <button onClick={clearTranscript} className="text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-200 transition-colors">
              Clear
            </button>
            <button onClick={clearAll} className="text-[10px] font-bold uppercase tracking-wider text-slate-500 hover:text-rose-400 transition-colors">
              Reset
            </button>

            {ENABLE_DONATIONS && DONATION_URL && (
              <a href={DONATION_URL} target="_blank" rel="noopener noreferrer" className="ml-2 bg-amber-500/10 text-amber-500 hover:bg-amber-500 hover:text-white border border-amber-500/50 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all">
                SUPPORT
              </a>
            )}
          </div>
        </header>

        {error && (
          <div className="mx-6 mt-4 p-3 bg-rose-500/10 border border-rose-500/50 rounded-lg text-rose-400 text-xs flex items-center gap-3 animate-in slide-in-from-top-2">
            <span className="shrink-0 font-bold">Error:</span> {error}
            <button onClick={() => setError(null)} className="ml-auto hover:text-white">✕</button>
          </div>
        )}

        <div className="flex-1 flex flex-col min-h-0">
          {auditReport && (
            <div className="mx-6 mt-6 p-6 bg-sky-500/5 border border-sky-500/20 rounded-2xl flex flex-col gap-4 animate-in zoom-in-95 duration-300">
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="text-sky-400 text-xs font-bold uppercase tracking-[0.15em]">Quality Audit Report</h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`w-2 h-2 rounded-full ${auditReport.status === "PASS" ? "bg-emerald-500" : "bg-rose-500"}`} />
                    <span className={`text-[10px] font-bold ${auditReport.status === "PASS" ? "text-emerald-400" : "text-rose-400"}`}>{auditReport.status}</span>
                  </div>
                </div>
                <button onClick={() => setAuditReport(null)} className="text-slate-600 hover:text-white transition-colors">✕</button>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div className="space-y-3">
                  <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Actionable Insights</span>
                  <ul className="space-y-2">
                    {auditReport.suggestedRules?.map((rule: string, i: number) => (
                      <li key={i} className="text-xs text-slate-300 flex gap-2 leading-relaxed">
                        <span className="text-sky-500 shrink-0">•</span> {rule}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="space-y-3">
                  <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Reasoning</span>
                  <p className="text-xs text-slate-400 leading-relaxed italic">{auditReport.reasoning}</p>
                </div>
              </div>
            </div>
          )}

          <div className="flex-1 flex min-h-0 divide-x divide-slate-800">
            {/* Source Panel */}
            <div className="flex-1 flex flex-col min-w-0">
              <div className="px-6 py-3 bg-slate-900/50 border-b border-slate-800 flex justify-between items-center shrink-0">
                <span className="text-[10px] font-bold tracking-[0.2em] text-slate-500 uppercase">Input: {detectedLabel}</span>
              </div>
              <div ref={sourcePanelRef} className="flex-1 overflow-y-auto p-8 space-y-6 custom-scrollbar scroll-smooth">
                {chunks.map(chunk => (
                  <p key={chunk.id} className={`text-sm leading-[1.8] font-medium transition-colors duration-500 ${chunk.isTranslating ? "text-slate-600 italic" : "text-slate-200 hover:text-white"}`}>
                    {chunk.sourceText || (chunk.isTranslating ? "Listening..." : "")}
                  </p>
                ))}
                {chunks.length === 0 && !isListening && (
                  <div className="h-full flex flex-col items-center justify-center text-slate-600 space-y-2 opacity-50">
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                    <p className="text-[10px] font-bold uppercase tracking-widest">Ready to Transcribe</p>
                  </div>
                )}
              </div>
            </div>

            {/* Translation Panel */}
            <div className="flex-1 flex flex-col min-w-0 bg-slate-950/20">
              <div className="px-6 py-3 bg-slate-900/50 border-b border-slate-800 flex justify-between items-center shrink-0">
                <span className="text-[10px] font-bold tracking-[0.2em] text-sky-500 uppercase">Translation: {targetLabel}</span>
              </div>
              <div ref={translatedPanelRef} className="flex-1 overflow-y-auto p-8 space-y-6 custom-scrollbar scroll-smooth">
                {chunks.map(chunk => (
                  <p key={chunk.id} className={`text-base leading-[1.8] font-medium transition-all duration-700 ${chunk.isTranslating ? "text-slate-700 italic translate-x-1" : "text-emerald-50/90 hover:text-white"}`}>
                    {chunk.translatedText || (chunk.isTranslating ? "Translating..." : "")}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>

        {showLogs && (
          <div className="h-48 border-t border-slate-800 bg-slate-950 flex flex-col animate-in slide-in-from-bottom-full duration-300">
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-900 shrink-0">
              <span className="text-[9px] font-bold text-slate-600 uppercase tracking-widest">System Logs</span>
              <div className="flex gap-4">
                <button onClick={clearLogs} className="text-[9px] text-slate-600 hover:text-slate-400 font-bold uppercase">Clear</button>
                <button onClick={() => setShowLogs(false)} className="text-[9px] text-slate-600 hover:text-white font-bold uppercase">✕</button>
              </div>
            </div>
            <div ref={logPanelRef} className="flex-1 overflow-y-auto p-4 font-mono text-[9px] space-y-1 custom-scrollbar">
              {logs.map(entry => (
                <div key={entry.id} className="flex gap-4 border-b border-slate-900/50 pb-1">
                  <span className="text-slate-700 shrink-0">{entry.time}</span>
                  <span className={`shrink-0 w-12 font-bold ${LOG_COLORS[entry.level]}`}>[{entry.level.toUpperCase()}]</span>
                  <span className="text-slate-500 whitespace-pre-wrap">{entry.msg}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Global Footer Actions */}
        {!showLogs && logs.length > 0 && (
          <div className="absolute bottom-4 right-6 flex items-center gap-2">
            <button onClick={() => setShowLogs(true)} className="bg-slate-800/80 backdrop-blur border border-slate-700 text-slate-400 hover:text-white px-3 py-1.5 rounded-full text-[10px] font-bold shadow-xl transition-all hover:scale-105">
              LOGS ({logs.length})
            </button>
          </div>
        )}
      </main>

      <style jsx global>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.05);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.1);
        }
      `}</style>
    </div>
  );
}
