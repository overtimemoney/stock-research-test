/* Stock Research — Supabase connection settings (TEST COPY ONLY).
 *
 * Leave both values as empty strings and the app behaves exactly like
 * the live version: localStorage only, no sign-in UI, no network calls
 * to Supabase, no errors.
 *
 * To turn cloud sync on, paste your project's values between the
 * quotes below (Supabase dashboard -> Project Settings -> API):
 *   SR_SUPABASE_URL      = Project URL, looks like
 *                          https://abcdefghijklmnop.supabase.co
 *   SR_SUPABASE_ANON_KEY = the "anon" / "publishable" key (a long
 *                          string starting with eyJ… or sb_publishable_…)
 *
 * The anon/publishable key is designed to be public — it is safe in
 * this file. Your data is protected by Row Level Security (see
 * supabase/schema.sql), not by hiding this key. NEVER paste the
 * "service_role" / "secret" key here.
 */
window.SR_SUPABASE_URL = 'https://osxsmodhgpawpoxknjde.supabase.co';
window.SR_SUPABASE_ANON_KEY = 'sb_publishable_6UWsulbPAqNIKJnPj_xxuA_03B7ztQD';
