-- ============================================================
-- Create conversations, messages, and message_reactions tables.
--
-- Every column name and type is verified directly against the
-- application code that reads from or writes to each table.
-- Safe to run multiple times — uses IF NOT EXISTS throughout.
-- ============================================================

-- ============================================================
-- TRIGGER FUNCTION
-- Keeps updated_at current on every row update.
-- CREATE OR REPLACE makes this idempotent.
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 1. CONVERSATIONS
--
-- Code reads/writes verified across:
--   webhook INSERT   : user_id, contact_id
--   webhook UPDATE   : last_message_text, last_message_at, unread_count, updated_at
--   inbox SELECT     : *, contact:contacts(*), ORDER BY last_message_at
--   inbox UPDATE     : unread_count (reset to 0 when thread opened)
--   automations/flows: status, assigned_agent_id, last_message_text, last_message_at
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id        UUID        NOT NULL REFERENCES contacts(id)   ON DELETE CASCADE,
  status            TEXT        NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open', 'pending', 'closed')),
  assigned_agent_id UUID,
  last_message_text TEXT,
  last_message_at   TIMESTAMPTZ,
  unread_count      INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id    ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_contact_id ON conversations(contact_id);
-- Inbox list is ordered by last_message_at DESC; partial index on user keeps it tight.
CREATE INDEX IF NOT EXISTS idx_conversations_last_msg
  ON conversations(user_id, last_message_at DESC NULLS LAST);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

-- Authenticated user (browser client) — full access to their own rows.
-- Service role (webhook) bypasses RLS automatically; no extra policy needed.
DROP POLICY IF EXISTS "Users can manage own conversations" ON conversations;
CREATE POLICY "Users can manage own conversations"
  ON conversations FOR ALL
  USING (auth.uid() = user_id);

-- Auto-bump updated_at on every UPDATE.
DROP TRIGGER IF EXISTS set_updated_at ON conversations;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 2. MESSAGES
--
-- Code reads/writes verified across:
--   webhook INSERT  : conversation_id, sender_type='customer', content_type,
--                     content_text, media_url, message_id, status='delivered',
--                     created_at, reply_to_message_id?, interactive_reply_id?
--   send API INSERT : conversation_id, sender_type='agent', content_type,
--                     content_text, media_url, template_name,
--                     message_id, status='sent', reply_to_message_id
--   flows INSERT    : conversation_id, sender_type='bot', content_type,
--                     content_text, template_name, message_id, status='sent'
--   webhook UPDATE  : status  WHERE message_id = <meta wamid>
--   inbox SELECT    : *  WHERE conversation_id
--   dashboard SELECT: created_at, sender_type, conversation_id, content_text
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type          TEXT        NOT NULL
                                   CHECK (sender_type IN ('customer', 'agent', 'bot')),
  sender_id            UUID,
  content_type         TEXT        NOT NULL DEFAULT 'text'
                                   CHECK (content_type IN (
                                     'text', 'image', 'document', 'audio', 'video',
                                     'location', 'template', 'interactive'
                                   )),
  content_text         TEXT,
  media_url            TEXT,
  template_name        TEXT,
  -- Meta's Cloud API wamid. Used to match delivery/read status callbacks
  -- and to detect swipe-replies (context.id). NOT unique — Meta can replay.
  message_id           TEXT,
  status               TEXT        NOT NULL DEFAULT 'sent'
                                   CHECK (status IN (
                                     'sending', 'sent', 'delivered', 'read', 'failed'
                                   )),
  -- Self-FK: set when this message is a WhatsApp swipe-reply.
  -- ON DELETE SET NULL: a deleted parent never cascades to children.
  reply_to_message_id  UUID        REFERENCES messages(id) ON DELETE SET NULL,
  -- For interactive button/list replies: the stable id of the tapped option.
  -- NULL for all non-interactive messages.
  interactive_reply_id TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_message_id   ON messages(message_id);
-- Partial index — most messages aren't replies so skip nulls.
CREATE INDEX IF NOT EXISTS idx_messages_reply_to     ON messages(reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Authenticated user: read/write messages in conversations they own.
-- Service role (webhook, send API internally): bypasses RLS automatically.
DROP POLICY IF EXISTS "Users can manage own messages" ON messages;
CREATE POLICY "Users can manage own messages"
  ON messages FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND c.user_id = auth.uid()
    )
  );

-- ============================================================
-- 3. MESSAGE_REACTIONS
--
-- Customer reactions arrive via the webhook (service role).
-- Agent reactions are written by the /api/whatsapp/react route
-- using the authenticated user's session.
-- Referenced by: webhook handleReaction(), /api/whatsapp/react
-- ============================================================
CREATE TABLE IF NOT EXISTS message_reactions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      UUID        NOT NULL REFERENCES messages(id)      ON DELETE CASCADE,
  conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  actor_type      TEXT        NOT NULL CHECK (actor_type IN ('customer', 'agent')),
  actor_id        UUID,
  emoji           TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, actor_type, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_conversation
  ON message_reactions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message
  ON message_reactions(message_id);

ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see reactions on their conversations" ON message_reactions;
CREATE POLICY "Users see reactions on their conversations"
  ON message_reactions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = message_reactions.conversation_id
        AND c.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users insert reactions on their conversations" ON message_reactions;
CREATE POLICY "Users insert reactions on their conversations"
  ON message_reactions FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = message_reactions.conversation_id
        AND c.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users delete own agent reactions" ON message_reactions;
CREATE POLICY "Users delete own agent reactions"
  ON message_reactions FOR DELETE
  USING (
    actor_type = 'agent'
    AND actor_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = message_reactions.conversation_id
        AND c.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Users update own agent reactions" ON message_reactions;
CREATE POLICY "Users update own agent reactions"
  ON message_reactions FOR UPDATE
  USING (
    actor_type = 'agent'
    AND actor_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = message_reactions.conversation_id
        AND c.user_id = auth.uid()
    )
  );

-- ============================================================
-- 4. REALTIME
-- Both tables must be in supabase_realtime so the inbox receives
-- live INSERT/UPDATE events without a full page reload.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'conversations'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE messages;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'message_reactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE message_reactions;
  END IF;
END $$;
