# AI Interaction Module - Troubleshooting Guide

## Common Issues

### Module Won't Start

#### Symptom
```
Error: Address already in use
```

**Solution:**
```bash
# Check if port is in use
netstat -tulpn | grep 8005

# Kill process using port
kill -9 <PID>

# Or use different port
MODULE_PORT=8006 python app.py
```

#### Symptom
```
Error: Could not connect to database
```

**Solution:**
```bash
# Test database connection
psql $DATABASE_URL -c "SELECT 1"

# Check connection string format
# Should be: postgresql://user:pass@host:port/db
echo $DATABASE_URL
```

---

### Provider Connection Issues

#### Ollama Provider Errors

**Symptom:**
```
Error: Connection refused to localhost:11434
```

**Solutions:**
1. Verify Ollama is running:
```bash
curl http://localhost:11434/api/tags
```

2. Check Ollama logs:
```bash
journalctl -u ollama -f
```

3. Restart Ollama:
```bash
systemctl restart ollama
```

#### WaddleAI Provider Errors

**Symptom:**
```
Error: 401 Unauthorized
```

**Solutions:**
1. Verify API key format (must start with `wa-`):
```bash
echo $WADDLEAI_API_KEY
```

2. Test API key:
```bash
curl http://waddleai-proxy:8000/health \
  -H "Authorization: Bearer $WADDLEAI_API_KEY"
```

3. Check WaddleAI service status:
```bash
curl http://waddleai-proxy:8000/health
```

---

### Response Issues

#### No Responses Generated

**Symptom:** Messages don't trigger AI responses

**Checklist:**
1. Check trigger patterns:
```python
# Does message contain trigger?
QUESTION_TRIGGERS=?  # Check config
```

2. Verify RESPOND_TO_EVENTS setting:
```bash
echo $RESPOND_TO_EVENTS  # Should be 'true'
```

3. Check logs for processing:
```bash
tail -f /var/log/waddlebotlog/ai_interaction_module.log | grep "process_interaction"
```

4. Test with explicit trigger:
```bash
curl -X POST http://localhost:8005/api/v1/ai/interaction \
  -d '{"message_content":"What is this?", ...}'
```

#### Slow Responses

**Symptom:** Responses take >5 seconds

**Solutions:**
1. Reduce max_tokens:
```env
AI_MAX_TOKENS=200  # Lower value
```

2. Increase timeout:
```env
REQUEST_TIMEOUT=60  # Higher value
```

3. Check provider latency:
```bash
time curl -X POST http://localhost:8005/api/v1/ai/test \
  -H "Authorization: Bearer key" \
  -d '{"message":"test"}'
```

4. Monitor provider health:
```bash
curl http://localhost:8005/metrics | grep provider_latency
```

#### Repetitive Responses

**Symptom:** AI gives same response repeatedly

**Solutions:**
1. Increase temperature:
```env
AI_TEMPERATURE=0.9  # Higher = more random
```

2. Enable conversation context:
```env
ENABLE_CHAT_CONTEXT=true
CONTEXT_HISTORY_LIMIT=10
```

3. Vary system prompt:
```env
SYSTEM_PROMPT="You are a creative and diverse assistant..."
```

---

### Authentication Issues

#### API Key Rejected

**Symptom:**
```
Error: 401 Unauthorized
```

**Solutions:**
1. Verify API key in header:
```bash
curl -H "Authorization: Bearer YOUR_KEY" ...
```

2. Check VALID_API_KEYS config:
```bash
echo $VALID_API_KEYS
```

3. Ensure key is in allowed list:
```env
VALID_API_KEYS=key1,key2,key3
```

---

### Performance Issues

#### High Memory Usage

**Symptom:** Module uses excessive RAM

**Solutions:**
1. Clear conversation context cache:
```python
# Reduce history limit
CONTEXT_HISTORY_LIMIT=3  # Lower value
```

2. Restart module periodically:
```bash
systemctl restart ai-interaction-module
```

3. Monitor memory:
```bash
ps aux | grep python | grep app.py
```

#### High CPU Usage

**Symptom:** CPU at 100%

**Solutions:**
1. Reduce concurrent requests:
```env
MAX_CONCURRENT_REQUESTS=5  # Lower value
```

2. Check for infinite loops in logs:
```bash
tail -f /var/log/waddlebotlog/ai_interaction_module.log
```

3. Profile code:
```bash
python -m cProfile app.py
```

---

### Configuration Issues

#### Invalid Configuration

**Symptom:**
```
Configuration errors: Invalid AI_PROVIDER
```

**Solutions:**
1. Verify provider value:
```bash
echo $AI_PROVIDER  # Must be 'ollama' or 'waddleai'
```

2. Run validation:
```python
from config import Config
Config.validate()
```

3. Check all required env vars:
```bash
env | grep -E '(AI_|OLLAMA_|WADDLEAI_)'
```

#### Missing Environment Variables

**Symptom:**
```
Error: WADDLEAI_API_KEY is required
```

**Solutions:**
1. Create .env file:
```env
AI_PROVIDER=waddleai
WADDLEAI_API_KEY=wa-your-key
WADDLEAI_BASE_URL=http://waddleai:8000
```

2. Load environment:
```bash
source .env
```

3. Verify loaded:
```bash
echo $WADDLEAI_API_KEY
```

---

### Database Issues

#### Connection Errors

**Symptom:**
```
Error: could not connect to server
```

**Solutions:**
1. Check PostgreSQL is running:
```bash
systemctl status postgresql
```

2. Verify connection string:
```bash
psql $DATABASE_URL -c "SELECT version()"
```

3. Check network connectivity:
```bash
ping postgres-host
telnet postgres-host 5432
```

#### Query Errors

**Symptom:**
```
Error: relation "ai_conversation_context" does not exist
```

**Solutions:**
1. Run migrations:
```bash
psql $DATABASE_URL < migrations/create_tables.sql
```

2. Verify tables exist:
```sql
\dt ai_*
```

---

### Debugging Tips

1. **Enable Debug Logging:**
```env
LOG_LEVEL=DEBUG
```

2. **Check All Logs:**
```bash
tail -f /var/log/waddlebotlog/ai_interaction_module.log
```

3. **Test Individual Components:**
```python
# Test provider directly
from services.ai_service import AIService
service = AIService.create()
await service.health_check()
```

4. **Monitor Metrics:**
```bash
curl http://localhost:8005/metrics
```

5. **Verify Environment:**
```bash
env | sort
```

---

## Error Reference

| Error Code | Meaning | Solution |
|------------|---------|----------|
| 400 | Invalid request | Check request format |
| 401 | Unauthorized | Verify API key |
| 403 | Forbidden | Check permissions |
| 404 | Not found | Verify endpoint path |
| 429 | Rate limited | Reduce request rate |
| 500 | Server error | Check logs |
| 503 | Service unavailable | Check provider health |

---

## Getting Help

1. **Check logs first:**
```bash
tail -100 /var/log/waddlebotlog/ai_interaction_module.log
```

2. **Test with minimal config:**
```env
AI_PROVIDER=ollama
OLLAMA_HOST=localhost
MODULE_PORT=8005
```

3. **Verify all services:**
```bash
curl http://localhost:8005/health
curl http://localhost:11434/api/tags
```

4. **Contact support with:**
- Module version
- Error messages
- Configuration (sanitized)
- Log snippets
