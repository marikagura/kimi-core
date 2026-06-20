-- Add a neutral GENERAL value to the Domain enum. Two topic-creation sites — the
-- depth-tag topic and the chat-digest routing topic — always meant a generic
-- domain and wrote "GENERAL", but the enum lacked it (masked by `as any`, which
-- Postgres rejects on insert). Additive and non-breaking: existing enum values and
-- rows are untouched.

-- AlterEnum
ALTER TYPE "Domain" ADD VALUE 'GENERAL';
