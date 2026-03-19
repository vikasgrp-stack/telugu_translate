import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";

const LOG_FILE = path.join(process.cwd(), "logs", "session.log");

export async function POST(req: NextRequest) {
  const { entries } = await req.json();
  if (!Array.isArray(entries)) return new Response("bad request", { status: 400 });

  const lines = entries
    .map((e: { time: string; level: string; msg: string }) => `${e.time} [${e.level.toUpperCase().padEnd(6)}] ${e.msg}`)
    .join("\n");

  fs.appendFileSync(LOG_FILE, lines + "\n");
  return new Response("ok");
}

export async function DELETE() {
  fs.writeFileSync(LOG_FILE, "");
  return new Response("ok");
}
