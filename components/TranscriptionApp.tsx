"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import pkg from "../package.json";

const LS_GROQ_KEY   = "tt_groq_key";
const LS_GEMINI_KEY = "tt_gemini_key";
const LS_CONTEXT    = "tt_global_context";
const LS_VOICE      = "tt_selected_voice";
const LS_TTS_ON     = "tt_tts_enabled";
const LS_TTS_RATE   = "tt_tts_rate";

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
  const { data: session } = useSession();
  const [isListening, setIsListening]     = useState(false);
  const [chunks, setChunks]               = useState<TranscriptChunk[]>([]);
  const [error, setError]                 = useState<string | null>(null);
  const [nextFlushIn, setNextFlushIn]     = useState<number | null>(null);
  const [batchSec, setBatchSec]           = useState(30);
  const [logs, setLogs]                   = useState<LogEntry[]>([]);
  const [showLogs, setShowLogs]           = useState(false);
  const [showSidebar, setShowSidebar]     = useState(true);
  const [isPinned, setIsPinned]           = useState(true);
  const [showAudit, setShowAudit]         = useState(false);
  const [recording, setRecording]         = useState(false);
  const [saving, setSaving]               = useState(false);
  const [provider, setProvider]           = useState<"gemini" | "groq">("gemini");
  const [targetLanguage, setTargetLanguage] = useState<"english" | "hindi">("english");
  const [audioSource, setAudioSource]     = useState<"mic" | "system">("system");
  const [globalContext, setGlobalContext] = useState("");
  const [onlineCount, setOnlineCount]     = useState(1);
  const [duplicatesBlocked, setDuplicatesBlocked] = useState(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [auditReport, setAuditReport]     = useState<any>(null);
  const [tokenStats, setTokenStats]       = useState<TokenStats | null>(null);
  const tokenStatsRef                     = useRef<TokenStats | null>(null);
  
  const [groqKey, setGroqKey]             = useState("");
  const [geminiKey, setGeminiKey]         = useState("");
  const [keysVisible, setKeysVisible]     = useState(true);
  
  // TTS State
  const [ttsEnabled, setTtsEnabled]       = useState(false);
  const [voices, setVoices]               = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>("");
  const [speakingId, setSpeakingId]       = useState<string | null>(null);
  const [ttsRate, setTtsRate]             = useState(1.1);

  // Persistence Refs (Agent Fix #1)
  const ttsRateRef                        = useRef(1.1);
  const selectedVoiceRef                  = useRef("");
  const voicesRef                         = useRef<SpeechSynthesisVoice[]>([]);
  const ttsEnabledRef                     = useRef(false);
  const isMounted                         = useRef(true);

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
  const bottomAnchorRef   = useRef<HTMLDivElement>(null);

  // ── Initialization & Cleanup ───────────────────────────────────────────────
  useEffect(() => {
    return () => { isMounted.current = false; };
  }, []);

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
      } catch { /* ignore */ }
    };

    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 30000);
    return () => clearInterval(interval);
  }, []);

  // Sync refs
  useEffect(() => { batchSecRef.current = batchSec; }, [batchSec]);
  useEffect(() => { providerRef.current = provider; }, [provider]);
  useEffect(() => { targetLanguageRef.current = targetLanguage; }, [targetLanguage]);
  useEffect(() => { globalContextRef.current = globalContext; localStorage.setItem(LS_CONTEXT, globalContext); }, [globalContext]);
  useEffect(() => { chunksRef.current = chunks; }, [chunks]);

  // Load Preferences
  useEffect(() => {
    setGroqKey(localStorage.getItem(LS_GROQ_KEY)   ?? "");
    setGeminiKey(localStorage.getItem(LS_GEMINI_KEY) ?? "");
    setGlobalContext(localStorage.getItem(LS_CONTEXT) ?? "");
    setTtsEnabled(localStorage.getItem(LS_TTS_ON) === "true");
    setSelectedVoice(localStorage.getItem(LS_VOICE) ?? "");
    setTtsRate(Number(localStorage.getItem(LS_TTS_RATE) ?? "1.1"));

    const loadVoices = (retries = 0) => {
      const available = window.speechSynthesis.getVoices();
      if (available.length === 0 && retries < 10) {
        setTimeout(() => loadVoices(retries + 1), 200);
        return;
      }
      const filtered = available.filter(v => {
        const isEnglish = v.lang.startsWith("en");
        const isHindi = v.lang.startsWith("hi");
        const isHighQuality = v.name.includes("Google") || v.name.includes("Natural") || v.name.includes("Online");
        return (isEnglish || isHindi) && (isHighQuality || v.default);
      });
      filtered.sort((a, b) => {
        if (a.name.includes("Google") && !b.name.includes("Google")) return -1;
        if (!a.name.includes("Google") && b.name.includes("Google")) return 1;
        return 0;
      });
      setVoices(filtered);
      voicesRef.current = filtered;
      if (!localStorage.getItem(LS_VOICE) && filtered.length > 0) {
        const best = filtered.find(v => v.name.includes("Google") && (v.name.includes("Hindi") || v.name.includes("\u0939\u093f\u0928\u094d\u0926\u0940"))) || filtered[0];
        if (best) {
          setSelectedVoice(best.name);
          selectedVoiceRef.current = best.name;
        }
      }
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = () => loadVoices();
  }, []);

  useEffect(() => { groqKeyRef.current = groqKey;     localStorage.setItem(LS_GROQ_KEY,   groqKey);   }, [groqKey]);
  useEffect(() => { geminiKeyRef.current = geminiKey; localStorage.setItem(LS_GEMINI_KEY, geminiKey); }, [geminiKey]);
  useEffect(() => { 
    ttsEnabledRef.current = ttsEnabled;
    localStorage.setItem(LS_TTS_ON, String(ttsEnabled)); 
  }, [ttsEnabled]);
  
  useEffect(() => { 
    selectedVoiceRef.current = selectedVoice;
    localStorage.setItem(LS_VOICE, selectedVoice); 
  }, [selectedVoice]);
  
  useEffect(() => { 
    ttsRateRef.current = ttsRate;
    localStorage.setItem(LS_TTS_RATE, String(ttsRate)); 
  }, [ttsRate]);

  // ── Speech Engine (Agent Fix #1 & #2) ──────────────────────────────────────
  const speakText = useCallback((text: string, id: string | null = null) => {
    if (!ttsEnabledRef.current || !text) return;
    
    const cleanText = text.replace(/\[\.\.\.continues\]/g, "").trim();
    if (!cleanText) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(cleanText);
    
    // Always use live Ref values to bypass stale closures
    const currentVoices = voicesRef.current.length > 0 ? voicesRef.current : window.speechSynthesis.getVoices();
    const voice = currentVoices.find(v => v.name === selectedVoiceRef.current);
    
    if (voice) utterance.voice = voice;
    else if (currentVoices.length > 0) utterance.voice = currentVoices[0];
    
    utterance.rate = ttsRateRef.current;
    utterance.volume = 1.0;
    
    utterance.onstart = () => isMounted.current && id && setSpeakingId(id);
    utterance.onend = () => isMounted.current && setSpeakingId(null);
    utterance.onerror = (e) => {
      console.error("TTS Error:", e);
      if (isMounted.current) setSpeakingId(null);
      window.speechSynthesis.resume();
    };
    
    window.speechSynthesis.speak(utterance);
  }, []); // Ref-only dependencies ensure no closure stale

  // Hot-swap speech settings
  useEffect(() => {
    if (ttsEnabled && speakingId && speakingId !== "test") {
      const currentChunk = chunksRef.current.find(c => c.id === speakingId);
      if (currentChunk && currentChunk.translatedText) {
        speakText(currentChunk.translatedText, currentChunk.id);
      }
    }
  }, [ttsRate, selectedVoice, ttsEnabled, speakText]);

  const toggleTTS = () => {
    const newState = !ttsEnabled;
    setTtsEnabled(newState);
    if (!newState) {
      window.speechSynthesis.cancel();
    } else {
      const warmUp = new SpeechSynthesisUtterance("");
      window.speechSynthesis.speak(warmUp);
    }
  };

  const testVoice = () => {
    const text = "Spiritual translation engine engaged. Testing current voice.";
    speakText(text, "test");
  };

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
    addLog("info", `Attempting to save session with ${data.length} chunks...`);
    if (data.length === 0) return;

    setSaving(true);
    addLog("info", "Sending session to server for storage and auto-audit...");

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
      // Keys are removed from payload for security; backend will use .env
    };

    try {
      const res = await fetch("/api/sessions/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          geminiKey: geminiKeyRef.current.trim() || undefined,
          groqKey: groqKeyRef.current.trim() || undefined,
        }),
      });
      
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `Server returned ${res.status}`);
      
      addLog("info", `Session saved as ${result.filename}`);

      if (result.auditReport) {
        addLog("info", `Auto-audit complete. Status: ${result.auditReport.status}`);
        setAuditReport(result.auditReport);
        
        // Only show flyout on Localhost
        if (window.location.hostname === "localhost") {
          setShowAudit(true);
        }
      } else {
        const errorDetail = result.auditError || "Unknown audit failure";
        addLog("error", `Quality audit failed: ${errorDetail}`);
      }

      // Downloaded JSON will NOT contain API keys
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
      addLog("error", `Failed to save session: ${err instanceof Error ? err.message : String(err)}`);
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
    setTimeout(() => saveToFile(), 2500);
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
        .map(c => ({ telugu: c.sourceText, english: c.translatedText }));

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

      if (data.isDuplicate) {
        setDuplicatesBlocked(prev => prev + 1);
        addLog("api", "Duplicate ASR loop detected and blocked (tokens saved).");
      }

      if (data.usage) {
        const u = data.usage;
        const prev = tokenStatsRef.current;
        const newStats = {
          sessionTotal:   (prev?.sessionTotal  ?? 0) + u.totalTokens,
          lastPrompt:     u.promptTokens,
          lastCompletion: u.completionTokens,
          lastBatch:      u.totalTokens,
          batchCount:     (prev?.batchCount    ?? 0) + 1,
          audioSeconds:   (prev?.audioSeconds  ?? 0) + batchSecRef.current,
          sessionStartMs: prev?.sessionStartMs ?? Date.now(),
        };
        tokenStatsRef.current = newStats;
        setTokenStats(newStats);
      }

      setChunks(prev => prev.map(c =>
        c.id === chunkId
          ? { ...c, sourceText: data.sourceText, translatedText: data.translatedText, detectedLanguage: data.detectedLanguage, isTranslating: false }
          : c
      ));

      if (data.translatedText && !data.isDuplicate) {
        speakText(data.translatedText, chunkId);
      }
    } catch (err) {
      addLog("error", `API Error: ${err instanceof Error ? err.message : String(err)}`);
      setChunks(prev => prev.filter(c => c.id !== chunkId));
    }
  }, [addLog, speakText]);

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
    setLogs([]);
    logIdCounter = 0;
    pendingLogsRef.current = [];
    tokenStatsRef.current = null;
    setTokenStats(null);
    setAuditReport(null);
    setDuplicatesBlocked(0);

    try {
      let stream: MediaStream;
      if (audioSource === "system") {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        const audioTracks = displayStream.getAudioTracks();
        if (audioTracks.length === 0) {
          displayStream.getTracks().forEach(t => t.stop());
          throw new Error("No audio shared.");
        }
        stream = new MediaStream(audioTracks);
        displayStream.getVideoTracks()[0]?.addEventListener("ended", () => stopListening());
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { autoGainControl: true } });
      }

      isListeningRef.current = true;
      setIsListening(true);
      setError(null);
      
      // Auto-enable Speaker and warm up the engine
      setTtsEnabled(true);
      ttsEnabledRef.current = true;
      const warmUp = new SpeechSynthesisUtterance("");
      window.speechSynthesis.speak(warmUp);
      
      startRecorderSegment(stream);
      scheduleBatch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes("NotAllowedError") ? "Audio access denied." : msg);
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

  // Autoscroll 2.0
  useEffect(() => {
    if (bottomAnchorRef.current) {
      bottomAnchorRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [chunks, logs]);

  const lastChunkWithLang = [...chunks].reverse().find(c => c.detectedLanguage);
  const detectedLabel = lastChunkWithLang?.detectedLanguage || "Voice";
  const targetLabel = targetLanguage === "english" ? (lastChunkWithLang?.detectedLanguage?.toLowerCase() === "english" ? "Hindi" : "English") : "Hindi";
  
  const tokenPercentage = Math.min(100, ((tokenStats?.sessionTotal ?? 0) / 1000000) * 100);

  return (
    <div className="h-screen flex bg-slate-50 text-slate-900 font-sans overflow-hidden relative">
      {/* Sidebar */}
      <aside 
        className={`transition-all duration-300 border-r border-slate-200 bg-white flex flex-col shrink-0 z-50
          ${isPinned ? "relative" : "absolute inset-y-0 left-0 shadow-2xl"}
          ${showSidebar ? "w-80 translate-x-0" : "w-0 -translate-x-full overflow-hidden border-none"}`}
      >
        <div className="p-6 flex flex-col gap-8 h-full overflow-y-auto custom-scrollbar">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Control Panel</h2>
            <div className="flex items-center gap-2">
              <button onClick={() => setIsPinned(!isPinned)} className={`p-1.5 rounded-md transition-colors ${isPinned ? "text-sky-500 bg-sky-50" : "text-slate-400 hover:bg-slate-100"}`}>
                <svg className="w-4 h-4" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v2l2 2v4l-2 2v2a2 2 0 01-2 2H7a2 2 0 01-2-2v-2l-2-2v-4l2-2V5z" /></svg>
              </button>
              <button onClick={() => setShowSidebar(false)} className="p-1.5 text-slate-400 hover:bg-slate-100 rounded-md">✕</button>
            </div>
          </div>

          <section className="space-y-6">
            {!session ? (
              <div className="p-6 bg-sky-50 border border-sky-100 rounded-2xl flex flex-col items-center gap-4 text-center">
                <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center shadow-sm">
                  <svg className="w-6 h-6 text-sky-500" fill="currentColor" viewBox="0 0 24 24"><path d="M12.48 10.92v3.28h7.84c-.24 1.84-2.21 5.39-7.84 5.39-4.84 0-8.75-4.01-8.75-8.96s3.91-8.96 8.75-8.96c2.75 0 4.59 1.16 5.64 2.17l2.59-2.5c-1.66-1.54-3.83-2.48-8.23-2.48-5.96 0-10.8 4.84-10.8 10.8s4.84 10.8 10.8 10.8c6.22 0 10.38-4.38 10.38-10.56 0-.71-.08-1.25-.18-1.79h-10.2z"/></svg>
                </div>
                <div className="space-y-1">
                  <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Members Only</h3>
                  <p className="text-[10px] text-slate-500 leading-relaxed">Sign in with Google to start your transcription session.</p>
                </div>
                <button 
                  onClick={() => signIn("google")}
                  className="w-full py-2.5 bg-white border border-slate-200 text-slate-700 rounded-xl text-[10px] font-bold uppercase tracking-widest hover:bg-slate-50 transition-all shadow-sm"
                >
                  Sign in with Google
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
                {session.user?.image && (
                  <img src={session.user.image} alt="User" className="w-8 h-8 rounded-full border border-white shadow-sm" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold text-slate-900 truncate">{session.user?.name}</p>
                  <p className="text-[9px] text-slate-400 truncate">{session.user?.email}</p>
                </div>
                <button onClick={() => signOut()} className="p-1.5 text-slate-400 hover:text-rose-500 transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                </button>
              </div>
            )}

            <button 
              onClick={isListening ? stopListening : startListening} 
              disabled={!session && !isListening}
              className={`w-full py-3 rounded-xl font-bold text-xs uppercase tracking-[0.2em] transition-all shadow-lg hover:scale-[1.02] active:scale-[0.98] ${!session && !isListening ? "bg-slate-200 text-slate-400 cursor-not-allowed shadow-none" : isListening ? "bg-rose-500 hover:bg-rose-600 text-white shadow-rose-200" : "bg-sky-500 hover:bg-sky-600 text-white shadow-sky-200"}`}
            >
              {isListening ? "Stop Listening" : "Start Listening"}
            </button>

            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Speaker Output</label>
                {ttsEnabled && (
                  <button onClick={testVoice} className="text-[9px] font-bold text-sky-600 uppercase hover:underline">Test Voice</button>
                )}
              </div>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={toggleTTS}
                  className={`flex items-center gap-3 px-4 py-2 rounded-lg border transition-all ${ttsEnabled ? "bg-emerald-50 border-emerald-200 text-emerald-700 shadow-sm" : "bg-slate-50 border-slate-200 text-slate-400"}`}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" /></svg>
                  <span className="text-xs font-bold uppercase tracking-wider">{ttsEnabled ? "Speaker ON" : "Speaker OFF"}</span>
                </button>
                <div className="space-y-1">
                  <div className="flex justify-between items-center px-1">
                    <span className="text-[9px] font-bold text-slate-400 uppercase">Speed</span>
                    <span className="text-[9px] font-bold text-sky-600">{ttsRate}x</span>
                  </div>
                  <input type="range" min={0.5} max={2} step={0.1} value={ttsRate} onChange={(e) => setTtsRate(Number(e.target.value))} className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-sky-500" />
                </div>
                <select 
                  value={selectedVoice} 
                  onChange={(e) => setSelectedVoice(e.target.value)}
                  className="w-full bg-slate-50 text-slate-900 border border-slate-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-sky-500/20"
                >
                  <option value="">Default Voice</option>
                  {voices.map(v => <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>)}
                </select>
              </div>
            </div>

            <div className="space-y-3 pt-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Audio Configuration</label>
              <div className="space-y-4">
                <select value={audioSource} onChange={(e) => setAudioSource(e.target.value as "mic" | "system")} disabled={isListening} className="w-full bg-slate-50 text-slate-900 border border-slate-200 rounded-lg px-3 py-2 text-xs">
                  <option value="mic">Microphone</option>
                  <option value="system">System Audio</option>
                </select>
                <select value={provider} onChange={(e) => setProvider(e.target.value as "gemini" | "groq")} disabled={isListening} className="w-full bg-slate-50 text-slate-900 border border-slate-200 rounded-lg px-3 py-2 text-xs">
                  <option value="groq">Groq (Whisper + LLaMA)</option>
                  <option value="gemini">Gemini 2.5 Flash</option>
                </select>
              </div>
            </div>

            <div className="space-y-3">
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">API Keys</label>
              <div className="space-y-2">
                <input type={keysVisible ? "text" : "password"} value={groqKey} onChange={e => setGroqKey(e.target.value)} placeholder="Groq Key" className="w-full bg-slate-50 text-slate-900 border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono" />
                <input type={keysVisible ? "text" : "password"} value={geminiKey} onChange={e => setGeminiKey(e.target.value)} placeholder="Gemini Key" className="w-full bg-slate-50 text-slate-900 border border-slate-200 rounded-lg px-3 py-2 text-xs font-mono" />
                <button onClick={() => setKeysVisible(v => !v)} className="text-[10px] text-slate-400 hover:text-slate-600 flex items-center gap-1 font-medium">
                  {keysVisible ? "Hide Keys" : "Show Keys"}
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Speech Context</label>
              <textarea value={globalContext} onChange={(e) => setGlobalContext(e.target.value)} placeholder="Topic, speakers..." className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs h-32 resize-none" />
            </div>
          </section>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 bg-transparent relative">
        <header className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-white/80 backdrop-blur-md z-40 sticky top-0">
          <div className="flex items-center gap-4">
            {!showSidebar && (
              <button onClick={() => setShowSidebar(true)} className="p-2 -ml-2 text-slate-400 hover:text-slate-900 transition-colors bg-slate-50 rounded-lg">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
              </button>
            )}
            <h1 className="text-sm font-bold text-slate-900 flex items-center gap-2">BhaktiTranslate</h1>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center bg-slate-100 rounded-lg p-1 mr-2 border border-slate-200/50">
              <button onClick={() => setTargetLanguage("english")} className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${targetLanguage === "english" ? "bg-white text-sky-600 shadow-sm" : "text-slate-400"}`}>ENGLISH</button>
              <button onClick={() => setTargetLanguage("hindi")} className={`px-3 py-1 rounded-md text-[10px] font-bold transition-all ${targetLanguage === "hindi" ? "bg-white text-sky-600 shadow-sm" : "text-slate-400"}`}>HINDI</button>
            </div>
            {auditReport && (
              <button onClick={() => setShowAudit(true)} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-sky-50 border border-sky-100 hover:bg-sky-100 transition-all">
                <span className={`w-2 h-2 rounded-full ${auditReport.status === "PASS" ? "bg-emerald-500" : "bg-rose-500"}`} />
                <span className="text-[10px] font-bold text-sky-700 uppercase tracking-wider">Quality: {auditReport.status}</span>
              </button>
            )}
            <div className="h-4 w-[1px] bg-slate-200 mx-1" />
            <button onClick={clearTranscript} className="text-[10px] font-bold uppercase text-slate-400 hover:text-slate-600">Clear</button>
            <button onClick={clearAll} className="text-[10px] font-bold uppercase text-slate-400 hover:text-rose-500">Reset</button>
          </div>
        </header>

        {/* Scrollable Container */}
        <div className="flex-1 overflow-y-auto custom-scrollbar relative p-6 pb-32">
          <div className="flex min-h-0 gap-6">
            {/* Source Panel */}
            <div className="flex-1 flex flex-col min-w-0 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-6 py-3 bg-slate-50 border-b border-slate-100 text-[10px] font-bold tracking-[0.2em] text-slate-400 uppercase">Input: {detectedLabel}</div>
              <div className="p-8 space-y-6 natural-gradient">
                {chunks.map((chunk, i) => (
                  <p key={chunk.id} className={`text-sm leading-[1.8] font-medium transition-all duration-500 ${chunk.isTranslating ? "text-slate-400 italic" : "text-slate-700"} ${i === chunks.length-1 ? "ring-2 ring-sky-100 bg-sky-50/30 rounded-lg p-2 -mx-2 shadow-sm" : ""}`}>
                    {chunk.sourceText || (chunk.isTranslating ? "Listening..." : "")}
                  </p>
                ))}
              </div>
            </div>

            {/* Translation Panel */}
            <div className="flex-1 flex flex-col min-w-0 bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-6 py-3 bg-slate-50 border-b border-slate-100 text-[10px] font-bold tracking-[0.2em] text-sky-600 uppercase">Translation: {targetLabel}</div>
              <div className="p-8 space-y-6 bg-gradient-to-br from-white to-sky-50/30">
                {chunks.map((chunk, i) => (
                  <div key={chunk.id} className={`transition-all duration-700 ${i === chunks.length-1 ? "ring-2 ring-sky-200 bg-white rounded-lg p-2 -mx-2 shadow-md animate-pulse-subtle" : ""}`}>
                    <div className="flex items-start justify-between gap-4">
                      <p className={`flex-1 text-base leading-[1.8] font-semibold ${chunk.isTranslating ? "text-slate-300 italic translate-x-1" : "text-sky-900/90"}`}>
                        {chunk.translatedText || (chunk.isTranslating ? "Translating..." : "")}
                      </p>
                      {speakingId === chunk.id && (
                        <div className="mt-2 shrink-0 flex items-center gap-1.5 px-2 py-1 bg-emerald-50 rounded-full border border-emerald-100">
                          <span className="flex gap-0.5 items-end h-3">
                            <span className="w-0.5 bg-emerald-500 rounded-full animate-bounce h-full" />
                            <span className="w-0.5 bg-emerald-500 rounded-full animate-bounce h-2 delay-75" />
                            <span className="w-0.5 bg-emerald-500 rounded-full animate-bounce h-3 delay-150" />
                          </span>
                          <span className="text-[8px] font-bold text-emerald-600 uppercase tracking-tighter">Speaking</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div ref={bottomAnchorRef} className="h-4" />
        </div>

        {/* Floating Action Bar */}
        {isListening && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[500px] z-50 bg-white/90 backdrop-blur-xl border border-slate-200 shadow-2xl rounded-2xl p-4 flex flex-col gap-3 animate-in slide-in-from-bottom-8">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <button onClick={stopListening} className="bg-rose-500 hover:bg-rose-600 text-white px-6 py-2 rounded-xl text-xs font-bold uppercase tracking-widest transition-all hover:scale-105 active:scale-95 shadow-lg shadow-rose-200">
                  Stop Listening
                </button>
                <div className="flex flex-col">
                  <span className="text-[10px] font-bold text-sky-600 uppercase tracking-widest">Processing</span>
                  <span className="text-xs font-mono font-black">{nextFlushIn}s Remaining</span>
                </div>
              </div>
              <div className="flex items-center gap-6">
                {duplicatesBlocked > 0 && (
                  <div className="text-right">
                    <div className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest">Saved</div>
                    <div className="text-xs font-mono font-bold text-emerald-600">{duplicatesBlocked} Loops</div>
                  </div>
                )}
                <div className="text-right">
                  <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Quota ({tokenPercentage.toFixed(1)}%)</div>
                  <div className="text-xs font-mono font-bold text-slate-900">{(tokenStats?.sessionTotal ?? 0).toLocaleString()} / 1M</div>
                </div>
              </div>
            </div>
            
            {/* Quota Progress Bar */}
            <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
              <div 
                className={`h-full transition-all duration-1000 rounded-full ${tokenPercentage > 80 ? "bg-rose-500" : tokenPercentage > 50 ? "bg-amber-500" : "bg-emerald-500"}`}
                style={{ width: `${tokenPercentage}%` }}
              />
            </div>
          </div>
        )}

        {/* Audit Flyout */}
        <div className={`absolute inset-y-0 right-0 w-96 bg-white shadow-2xl border-l border-slate-200 transform transition-transform duration-500 ease-in-out z-50 flex flex-col ${showAudit && auditReport ? "translate-x-0" : "translate-x-full"}`}>
          <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
            <div className="flex items-center gap-3">
              <div className={`w-2 h-2 rounded-full animate-pulse ${auditReport?.status === "PASS" ? "bg-emerald-500" : "bg-rose-500"}`} />
              <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-slate-900">Quality Audit</h3>
            </div>
            <button onClick={() => setShowAudit(false)} className="p-2 hover:bg-slate-200 rounded-full transition-colors">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto p-8 space-y-8 custom-scrollbar">
            <section className="space-y-4">
              <div className="flex justify-between items-end"><span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Verdict</span><span className={`text-lg font-black ${auditReport?.status === "PASS" ? "text-emerald-500" : "text-rose-500"}`}>{auditReport?.status}</span></div>
              <div className="h-1 w-full bg-slate-100 rounded-full overflow-hidden">
                <div className={`h-full transition-all duration-1000 ${auditReport?.status === "PASS" ? "w-full bg-emerald-500" : "w-1/3 bg-rose-500"}`} />
              </div>
            </section>
            <section className="space-y-4">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">Actionable Insights</label>
              <div className="space-y-3">
                {auditReport?.suggestedRules?.map((rule: string, i: number) => (
                  <div key={i} className="p-4 rounded-xl bg-slate-50 border border-slate-100 text-xs text-slate-700 shadow-sm">{rule}</div>
                ))}
              </div>
            </section>
          </div>
          <div className="p-6 bg-slate-50 border-t border-slate-100">
            <button onClick={() => setShowAudit(false)} className="w-full py-3 bg-slate-900 text-white rounded-xl text-xs font-bold uppercase tracking-widest">Acknowledge</button>
          </div>
        </div>

        {/* System Logs */}
        {showLogs && (
          <div className="h-48 border-t border-slate-200 bg-white flex flex-col z-40">
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100 shrink-0">
              <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">System Logs</span>
              <div className="flex gap-4">
                <button onClick={clearLogs} className="text-[9px] text-slate-400 font-bold uppercase">Clear</button>
                <button onClick={() => setShowLogs(false)} className="text-[9px] text-slate-400 font-bold uppercase">✕</button>
              </div>
            </div>
            <div ref={logPanelRef} className="flex-1 overflow-y-auto p-4 font-mono text-[9px] space-y-1 custom-scrollbar">
              {logs.map(entry => (
                <div key={entry.id} className="flex gap-4 border-b border-slate-50 pb-1">
                  <span className="text-slate-300 shrink-0">{entry.time}</span>
                  <span className={`shrink-0 w-12 font-bold ${LOG_COLORS[entry.level]}`}>[{entry.level.toUpperCase()}]</span>
                  <span className="text-slate-400 whitespace-pre-wrap">{entry.msg}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Logs Toggle */}
        {!showLogs && logs.length > 0 && (
          <div className="absolute bottom-4 right-6 flex items-center gap-2 z-40">
            <button onClick={() => setShowLogs(true)} className="bg-white/80 backdrop-blur border border-slate-200 text-slate-400 px-3 py-1.5 rounded-full text-[10px] font-bold shadow-lg">
              LOGS ({logs.length})
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
