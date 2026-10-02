-- Only an aggregate budget is stored, never prompts or answers.
CREATE TABLE IF NOT EXISTS chat_daily_usage (
    day TEXT PRIMARY KEY,
    neuron_millis INTEGER NOT NULL DEFAULT 0 CHECK (neuron_millis >= 0)
);
