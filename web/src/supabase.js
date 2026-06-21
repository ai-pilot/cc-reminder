import { createClient } from "@supabase/supabase-js";

// These come from Vercel env vars (or web/.env locally).
// Use the PUBLIC anon key here — never the service_role key in the browser.
const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(url, anon);
