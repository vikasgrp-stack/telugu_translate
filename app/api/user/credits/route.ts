import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!supabase) {
    // Return a dummy value if Supabase is not configured
    return NextResponse.json({ credits: 15.0 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = (session.user as any).id;

  try {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('credits')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      return NextResponse.json({ credits: 0 });
    }

    return NextResponse.json({ credits: profile.credits });
  } catch (err) {
    console.error("Failed to fetch credits from Supabase:", err);
    return NextResponse.json({ credits: 0 });
  }
}
