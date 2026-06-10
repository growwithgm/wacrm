-- ============================================================
-- Phase 1: multi-tenant isolation hardening.
--
-- Based on the Phase 0 production audit (2026-06-10), which found:
--   • RLS enabled on all 31 public tables; no anywhere-true policies.
--   • Every row belongs to a single user; no NULL user_id; no orphans.
--   • profiles has RLS ON but ZERO policies in production — the three
--     001 policies are missing, so authenticated browser reads/writes
--     of the user's own profile silently fail. Restored below.
--
-- Safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. Webhook routing keys must be globally unique.
--
-- The WhatsApp webhook routes every inbound event to a tenant via
-- whatsapp_config.phone_number_id, and the Shopify webhook via
-- shopify_config.store_domain. Without a uniqueness guarantee, a
-- second tenant saving the same value makes the webhook's
-- .maybeSingle() lookup error — dropping BOTH tenants' events — or
-- lets a tenant claim another's store/number before they connect.
--
-- NOTE: CREATE UNIQUE INDEX fails if duplicate values already exist.
-- Verified clean in the Phase 0 audit (one row in each table).
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_config_phone_number_id
  ON whatsapp_config (phone_number_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_shopify_config_store_domain
  ON shopify_config (store_domain);

-- ============================================================
-- 2. Defense-in-depth: drop the legacy anywhere-true INSERT policy
--    from 001. The Phase 0 audit confirmed it does NOT exist in
--    production (no-op there), but any environment that ever ran 001
--    has it — this makes the drop part of the canonical schema.
-- ============================================================
DROP POLICY IF EXISTS "Service role can insert messages" ON messages;

-- ============================================================
-- 3. Restore the per-user policies on profiles (audit finding: RLS
--    is enabled but the policies from 001 are gone in production, so
--    the browser client can no longer read or update its own row).
--    Same own-row-only semantics as 001.
-- ============================================================
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;
CREATE POLICY "Users can insert own profile"
  ON profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
