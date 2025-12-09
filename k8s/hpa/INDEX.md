# WaddleBot Kubernetes HPA Configuration Index

Complete reference to all Horizontal Pod Autoscaler configurations and documentation.

## Configuration Files (3.8 KB + 2.5 KB + 9.1 KB = 15.4 KB)

### 1. **receiver-modules-hpa.yaml** (3.8 KB)
Autoscaler configurations for webhook receiver modules.

**Contents:**
- `twitch-collector-hpa`: 2-10 replicas, CPU 70%, Memory 80%
- `discord-collector-hpa`: 2-10 replicas, CPU 70%, Memory 80%
- `slack-collector-hpa`: 2-10 replicas, CPU 70%, Memory 80%
- `receiver-modules-pdb`: PodDisruptionBudget for availability

**Use Case:** High-throughput ingestion of events from multiple platforms

### 2. **router-hpa.yaml** (2.5 KB)
Autoscaler configuration for the central message processing hub.

**Contents:**
- `router-hpa`: 2-10 replicas, CPU 70%
- `router-pdb`: PodDisruptionBudget for HA
- Comments for future custom metrics integration

**Use Case:** CPU-intensive routing and command processing

### 3. **action-modules-hpa.yaml** (9.1 KB)
Autoscaler configurations for all interactive action modules.

**Contents:**
- `ai-interaction-hpa`: 2-8 replicas, CPU 70%, Memory 80%
- `alias-interaction-hpa`: 2-8 replicas, CPU 70%, Memory 80%
- `shoutout-interaction-hpa`: 2-8 replicas, CPU 70%, Memory 80%
- `inventory-interaction-hpa`: 2-8 replicas, CPU 70%, Memory 80%
- `calendar-interaction-hpa`: 2-8 replicas, CPU 70%, Memory 80%
- `memories-interaction-hpa`: 2-8 replicas, CPU 70%, Memory 80%
- `youtube-music-interaction-hpa`: 2-8 replicas, CPU 70%, Memory 80%
- `spotify-interaction-hpa`: 2-8 replicas, CPU 70%, Memory 80%
- `action-modules-pdb`: PodDisruptionBudget for action modules

**Use Case:** Variable compute workloads with resource-intensive operations

## Kustomization (1.1 KB)

### **kustomization.yaml**
Kustomization configuration for the HPA directory.

**Features:**
- Includes all HPA resources
- Adds common labels (app.kubernetes.io/*)
- Auto-generates HPA documentation ConfigMap
- Easy to include/exclude from main builds

**Usage:**
```bash
kubectl apply -k k8s/hpa/
```

## Documentation (14 KB + 5 KB + 3 KB + 7.8 KB = ~30 KB)

### 1. **README.md** (14 KB) - COMPREHENSIVE REFERENCE
Complete documentation for HPA configurations.

**Sections:**
- Overview of all HPA categories
- Detailed configuration explanation for each file
- Prerequisites and installation instructions
- Deployment procedures with verification steps
- Monitoring and troubleshooting guide (10+ common issues)
- Resource request/limit guidelines
- Scaling behavior details with examples
- Performance tuning recommendations
- Testing procedures with load generation
- Best practices checklist
- Integration with Kustomize
- References and support resources

**Read this first for:** Complete understanding of HPAs

### 2. **DEPLOYMENT_GUIDE.md** (7.8 KB) - STEP-BY-STEP
Production-ready deployment guide.

**Sections:**
- Prerequisites checklist
- Step-by-step deployment (7 steps)
- Verification procedures with commands
- Testing and validation
- Common deployment issues (4 detailed solutions)
- Rollback procedures
- Quick reference command cheatsheet
- Next steps and timeline
- Validation checklist

**Read this for:** Deploying HPAs to your cluster

### 3. **QUICK_REFERENCE.md** (1 KB) - COMMAND CHEATSHEET
One-page reference card with all common commands.

**Contents:**
- Deploy commands
- Status check commands
- Watch/monitoring commands
- Scaling test procedures
- HPA configuration table (all modules summary)
- Scaling behavior quick summary
- Troubleshooting checklist
- Resource links

**Read this for:** Quick lookup of commands while operating

### 4. **INTEGRATION.md** (7.8 KB) - ARCHITECTURE DETAILS
Integration with existing WaddleBot architecture.

**Sections:**
- Directory structure overview
- HPA naming convention explanation
- Compatibility with existing deployments
- Required features in deployments
- Kustomization integration options (3 methods)
- Upgrade and rollback procedures
- Monitoring integration
- Resource planning and capacity calculation
- Best practices
- Troubleshooting integration issues
- Performance impact analysis
- Compatibility matrix
- Migration timeline (4-week plan)
- Support and escalation procedures

**Read this for:** Understanding how HPAs fit into WaddleBot

### 5. **INDEX.md** (THIS FILE)
Navigation guide and quick overview of all files.

**Purpose:** Understand structure and find what you need

## Quick Navigation Guide

### I want to...

**Deploy HPAs immediately**
→ See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) Section 1-3

**Understand how HPAs work**
→ See [README.md](README.md) Sections 2-3

**Check status and monitor**
→ See [QUICK_REFERENCE.md](QUICK_REFERENCE.md) (or [README.md](README.md) "Monitoring" section)

**Configure resource limits**
→ See [README.md](README.md) "Resource Request/Limit Guidelines"

**Troubleshoot issues**
→ See [README.md](README.md) "Troubleshooting" (or [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) "Common Issues")

**Tune HPA parameters**
→ See [README.md](README.md) "Performance Tuning"

**Understand integration with WaddleBot**
→ See [INTEGRATION.md](INTEGRATION.md) Sections 1-3

**Load test HPAs**
→ See [README.md](README.md) "Testing HPA" (or [QUICK_REFERENCE.md](QUICK_REFERENCE.md))

**See all common commands**
→ See [QUICK_REFERENCE.md](QUICK_REFERENCE.md)

## File Organization by Purpose

### Configuration Files
```
receiver-modules-hpa.yaml  - Twitch, Discord, Slack scaling
router-hpa.yaml            - Router/processing scaling
action-modules-hpa.yaml    - Interactive modules scaling
kustomization.yaml         - Kustomize integration
```

### Documentation Files
```
README.md                  - Full reference (start here)
DEPLOYMENT_GUIDE.md        - Step-by-step deployment
QUICK_REFERENCE.md         - Command cheatsheet
INTEGRATION.md             - Architecture integration
INDEX.md                   - This navigation guide
```

## Key Metrics and Targets

### Receiver Modules
- Min: 2 replicas | Max: 10 replicas
- CPU Target: 70% utilization
- Memory Target: 80% utilization
- Scale-up: 100% per 30s (60s window)
- Scale-down: 1 pod per 60s (300s window)

### Router Module
- Min: 2 replicas | Max: 10 replicas
- CPU Target: 70% utilization
- Scale-up: 100% per 30s (60s window)
- Scale-down: 1 pod per 60s (300s window)

### Action Modules
- Min: 2 replicas | Max: 8 replicas (per module)
- CPU Target: 70% utilization
- Memory Target: 80% utilization
- Scale-up: 100% per 30s (60s window)
- Scale-down: 1 pod per 60s (300s window)

## File Statistics

| File | Size | Lines | Purpose |
|------|------|-------|---------|
| receiver-modules-hpa.yaml | 3.8 KB | 171 | Receiver scaling config |
| router-hpa.yaml | 2.5 KB | 85 | Router scaling config |
| action-modules-hpa.yaml | 9.1 KB | 426 | Action modules scaling |
| kustomization.yaml | 1.1 KB | 43 | Kustomize integration |
| README.md | 14 KB | 461 | Full documentation |
| DEPLOYMENT_GUIDE.md | 7.8 KB | 302 | Deployment steps |
| QUICK_REFERENCE.md | 1 KB | 50 | Command reference |
| INTEGRATION.md | 7.8 KB | 315 | Architecture integration |
| INDEX.md | this file | ~200 | Navigation guide |
| **TOTAL** | **~68 KB** | **1700+** | **Complete HPA suite** |

## Production Readiness Checklist

- [x] Configuration files (3)
- [x] Kustomization file
- [x] Comprehensive documentation (14 KB README)
- [x] Step-by-step deployment guide
- [x] Quick reference card
- [x] Architecture integration guide
- [x] Navigation index
- [x] PodDisruptionBudgets for HA
- [x] Stabilization windows to prevent thrashing
- [x] Scaling behavior documentation with examples
- [x] Troubleshooting guide with 10+ solutions
- [x] Resource guidelines
- [x] Performance tuning recommendations
- [x] Load testing procedures
- [x] Compatibility matrix
- [x] Migration timeline
- [x] Best practices checklist
- [x] Support resources

## Getting Started (5 Minutes)

1. **Read** [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) "Prerequisites Checklist" (2 min)
2. **Verify** Prerequisites are met (1 min)
3. **Deploy** HPAs: `kubectl apply -f k8s/hpa/` (1 min)
4. **Check** Status: `kubectl get hpa -n waddlebot` (1 min)

## Common Commands Reference

```bash
# Deploy
kubectl apply -f k8s/hpa/

# Check status
kubectl get hpa -n waddlebot

# Watch scaling
kubectl get hpa -n waddlebot --watch

# Detailed info
kubectl describe hpa router-hpa -n waddlebot

# View metrics
kubectl top pods -n waddlebot

# See events
kubectl get events -n waddlebot --field-selector involvedObject.kind=HorizontalPodAutoscaler
```

See [QUICK_REFERENCE.md](QUICK_REFERENCE.md) for more commands.

## Support & Resources

- **Full Documentation:** [README.md](README.md)
- **Quick Commands:** [QUICK_REFERENCE.md](QUICK_REFERENCE.md)
- **Deployment Steps:** [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)
- **Architecture Details:** [INTEGRATION.md](INTEGRATION.md)
- **Kubernetes HPA Docs:** https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/
- **Metrics Server:** https://github.com/kubernetes-sigs/metrics-server

## Version Information

- **HPA API Version:** autoscaling/v2
- **Kubernetes Minimum:** 1.18+
- **WaddleBot Version:** 1.0.0+
- **Created:** 2025-12-09

---

**Start with:** [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for immediate deployment, or [README.md](README.md) for complete understanding.
