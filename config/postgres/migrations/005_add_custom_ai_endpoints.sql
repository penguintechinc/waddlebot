-- Add custom AI endpoint and API key support for premium users
-- Run this migration to add enterprise AI configuration fields

-- Add custom endpoint and API key columns
ALTER TABLE ai_researcher_config
ADD COLUMN IF NOT EXISTS custom_ai_endpoint VARCHAR(500),
ADD COLUMN IF NOT EXISTS custom_api_key_encrypted TEXT,
ADD COLUMN IF NOT EXISTS use_custom_endpoint BOOLEAN DEFAULT FALSE;

-- Add comments
COMMENT ON COLUMN ai_researcher_config.custom_ai_endpoint IS 'Custom AI endpoint URL for enterprise customers (Azure OpenAI, private Ollama, etc.)';
COMMENT ON COLUMN ai_researcher_config.custom_api_key_encrypted IS 'Encrypted API key for custom endpoint (premium only)';
COMMENT ON COLUMN ai_researcher_config.use_custom_endpoint IS 'Whether to use custom endpoint instead of default provider';
