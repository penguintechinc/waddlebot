# gRPC Port Registry - Action Modules

## Quick Reference

All gRPC ports are configured and operational. This document serves as the single source of truth for port assignments.

---

## Port Assignments

| Module | gRPC Port | REST Port | Config File | Status |
|--------|-----------|-----------|-------------|--------|
| **Discord** | 50051 | 8070 | `discord_action_module/config.py:26` | ✓ Active |
| **Slack** | 50052 | 8071 | `slack_action_module/config.py:20` | ✓ Active |
| **Twitch** | 50053 | 8072 | `twitch_action_module/config.py:24` | ✓ Active |
| **YouTube** | 50054 | 8073 | `youtube_action_module/config.py:16` | ✓ Active |
| **Lambda** | 50060 | 8080 | `lambda_action_module/config.py:29` | ✓ Active |
| **GCP Functions** | 50061 | 8081 | `gcp_functions_action_module/config.py:31` | ✓ Active |
| **OpenWhisk** | 50062 | 8082 | `openwhisk_action_module/config.py:30` | ✓ Active |

---

## Port Range Details

### gRPC Ports
- **Range:** 50051-50054, 50060-50062
- **Total:** 7 ports allocated
- **Reserved:** 50055-50059 (future expansion)
- **Pattern:** Module-specific static assignments with environment override capability

### REST Ports
- **Range:** 8070-8073, 8080-8082
- **Total:** 7 ports allocated
- **Pattern:** Sequential numbering within platform groups

---

## Environment Variable Configuration

All modules support port configuration via environment variables:

```bash
# Override gRPC port (all modules)
export GRPC_PORT=50051

# Override REST port (all modules)
export REST_PORT=8070
```

**Default Fallback:**
- If `GRPC_PORT` environment variable is not set, the module uses the default value from `config.py`
- If `REST_PORT` environment variable is not set, the module uses the default value from `config.py`

---

## Implementation Status

### gRPC Server Status

| Module | Type | File | Lines | Status |
|--------|------|------|-------|--------|
| Discord | Async Proto | `app.py` | 378-390 | ✓ Implemented |
| Slack | Factory | `app.py` | 433-456 | ✓ Implemented |
| Twitch | Custom Class | `app.py` | 86, 373-374 | ✓ Implemented |
| YouTube | Threaded | `app.py` | 46, 448-466 | ✓ Implemented |
| Lambda | Async Proto | `app.py` | 340-349 | ✓ Implemented |
| GCP Functions | Custom Class | `app.py` | 102, 439-440 | ✓ Implemented |
| OpenWhisk | Custom Class | `app.py` | 107, 573-574 | ✓ Implemented |

### Server Type Legend
- **Async Proto:** `grpc.aio.server()` with proto servicers
- **Factory:** Server creation via factory function
- **Custom Class:** Dedicated `GrpcServer` wrapper class
- **Threaded:** Background thread-based server

---

## Connection Testing

### Test gRPC Connectivity

```bash
# Using grpcurl (install: go install github.com/fullstorydev/grpcurl/cmd/grpcurl@latest)

# List services on Discord module
grpcurl -plaintext localhost:50051 list

# List services on Slack module
grpcurl -plaintext localhost:50052 list

# Test connection to any module
grpcurl -plaintext -d '{}' localhost:50051 <service>/<method>
```

### Port Availability Check

```bash
# Check if ports are in use
netstat -tuln | grep -E ":(50051|50052|50053|50054|50060|50061|50062)"

# Or using lsof
lsof -i :50051
```

---

## Deployment Checklist

Before deploying, ensure:

- [ ] All 7 modules are configured with their respective gRPC ports
- [ ] No port conflicts with other services on the deployment host
- [ ] Firewall rules allow inbound connections on gRPC ports (50051-50054, 50060-50062)
- [ ] Network load balancer (if used) is configured to route to correct module instances
- [ ] Monitoring is set up to track gRPC server health on all ports
- [ ] Log aggregation includes gRPC startup messages from all modules

---

## Troubleshooting

### gRPC Server Won't Start

1. **Check port availability:**
   ```bash
   netstat -tuln | grep <PORT>
   ```

2. **Verify configuration:**
   ```bash
   # Check GRPC_PORT env var
   echo $GRPC_PORT

   # Check config.py default
   grep "GRPC_PORT" <module>/config.py
   ```

3. **Review module logs:**
   ```bash
   tail -f /var/log/waddlebotlog/<module>.log
   ```

### Connection Refused

1. Ensure module is running
2. Verify correct port number
3. Check firewall rules
4. Confirm gRPC server initialization completed

---

## Related Documentation

- Full verification report: `../GRPC_PORT_VERIFICATION.md`
- Module-specific docs: Each module's `README.md`
- Proto definitions: `proto/` or `grpc_proto/` directories in each module

---

**Last Updated:** 2025-12-15
**Verification Status:** All Ports Verified ✓
**Configuration Status:** All Modules Correctly Configured ✓
