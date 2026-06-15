-- ============================================================
-- 031_recovery_discount.sql
-- Cart Recovery — attach a discount to a reminder.
--
-- Run BEFORE deploying the discount-on-reminder code. Idempotent.
--
-- One optional discount per reminder (1/2/3). When a reminder's template
-- maps a placeholder to the new "Discount code" source (or the button to
-- "Recovery link + discount"), the engine generates a unique single-use
-- code from THIS discount at send time and injects it. NULL = no discount
-- (today's behavior). ON DELETE SET NULL so removing a discount in the
-- Discounts section never breaks recovery config.
-- ============================================================

ALTER TABLE shopify_config
  ADD COLUMN IF NOT EXISTS recovery_template1_discount_id UUID REFERENCES discounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recovery_template2_discount_id UUID REFERENCES discounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recovery_template3_discount_id UUID REFERENCES discounts(id) ON DELETE SET NULL;
