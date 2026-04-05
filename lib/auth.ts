import GoogleProvider from "next-auth/providers/google";
import { supabase } from "@/lib/supabase";
import { NextAuthOptions } from "next-auth";

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      if (!user?.email || !user?.id) return true;
      if (!supabase) return true; // Safety check for missing credentials

      try {
        // Check if profile exists
        const { data: profile } = await supabase
          .from('profiles')
          .select('id')
          .eq('id', user.id)
          .single();

        if (!profile) {
          // Initialize new user with 15 credits
          await supabase.from('profiles').insert({
            id: user.id,
            email: user.email,
            credits: 15.0,
          });
        }
      } catch (err) {
        console.error("Auth Supabase sync failed:", err);
      }

      return true;
    },
    async session({ session, token }) {
      if (session?.user) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (session.user as any).id = token.sub;
      }
      return session;
    },
  },
  pages: {
    signIn: "/", // Redirect back to home
  },
};
