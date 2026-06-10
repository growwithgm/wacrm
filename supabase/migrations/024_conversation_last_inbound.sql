-- ============================================================
-- Track the customer's last INBOUND message per conversation.
--
-- The WhatsApp 24-hour customer service window is measured from
-- the customer's most recent inbound message — outbound agent/bot
-- messages (e.g. COD templates) must not reset it. The inbox
-- Open/Closed tabs filter on this column client-side.
--
-- Maintained going forward by the webhook (set alongside
-- last_message_at on every customer message insert).
-- Safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;

-- Backfill from existing messages: latest customer-sent message per
-- conversation. Conversations with no inbound message stay NULL
-- (treated as window-closed by the inbox).
UPDATE conversations c
SET last_inbound_at = sub.max_inbound
FROM (
  SELECT conversation_id, MAX(created_at) AS max_inbound
  FROM messages
  WHERE sender_type = 'customer'
  GROUP BY conversation_id
) sub
WHERE sub.conversation_id = c.id
  AND c.last_inbound_at IS DISTINCT FROM sub.max_inbound;
