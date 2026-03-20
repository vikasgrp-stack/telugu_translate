import { NextRequest } from "next/server";

// Simple in-memory presence tracking
// Note: On serverless (Vercel), this only counts users hitting the same edge instance/warm lambda.
// For 100% accuracy across all Vercel regions, a Redis store would be needed.
const activeSessions = new Map<string, number>();

export async function POST(req: NextRequest) {
  const { sessionId } = await req.json();
  if (!sessionId) return new Response("Missing sessionId", { status: 400 });

  const now = Date.now();
  activeSessions.set(sessionId, now);

  // Clean up sessions older than 45 seconds
  for (const [id, lastSeen] of activeSessions.entries()) {
    if (now - lastSeen > 45000) {
      activeSessions.delete(id);
    }
  }

  return new Response(JSON.stringify({ onlineCount: activeSessions.size }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET() {
  const now = Date.now();
  // Filter out stale sessions before counting
  let count = 0;
  for (const lastSeen of activeSessions.values()) {
    if (now - lastSeen <= 45000) count++;
  }
  
  return new Response(JSON.stringify({ onlineCount: Math.max(1, count) }), {
    headers: { "Content-Type": "application/json" },
  });
}
