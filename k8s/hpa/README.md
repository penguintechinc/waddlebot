# Kubernetes Horizontal Pod Autoscaler (HPA) Configurations

This directory contains production-ready Horizontal Pod Autoscaler configurations for WaddleBot's microservices. These configurations enable automatic scaling of pods based on resource utilization and custom metrics.

## Overview

WaddleBot's HPA strategy targets three main module categories:

1. **Receiver Modules** - Webhook ingestion points (Twitch, Discord, Slack)
2. **Router Module** - Central message processing hub
3. **Action Modules** - Interactive command execution (AI, Alias, Inventory, etc.)

## Configuration Files

### 1. receiver-modules-hpa.yaml

Manages scaling for platform-specific receiver modules:
- **Twitch Collector**: Handles Twitch EventSub webhooks
- **Discord Collector**: Processes Discord events
- **Slack Collector**: Ingests Slack messages

**Scaling Strategy:**
- Min replicas: 2 (ensures redundancy)
- Max replicas: 10 (handles peak load)
- Metrics:
  - CPU: 70% utilization target
  - Memory: 80% utilization target
- Behavior:
  - Fast scale-up (60s stabilization): Double pods every 30s
  - Conservative scale-down (300s stabilization): Remove 50% every 60s

**Why these settings:**
- Receivers are I/O-bound, handling high throughput of events
- Conservative scale-down prevents thrashing during traffic spikes
- Min 2 replicas ensures webhook availability and fail-over

### 2. router-hpa.yaml

Manages scaling for the central router (processing module):

**Scaling Strategy:**
- Min replicas: 2 (ensures high availability)
- Max replicas: 10 (handles concurrent message routing)
- Metrics:
  - CPU: 70% utilization target
- Behavior:
  - Fast scale-up (60s stabilization): Double pods every 30s
  - Conservative scale-down (300s stabilization): Remove 50% every 60s

**Why these settings:**
- Router is CPU-bound due to message routing, string matching, and command execution
- Aggressive scale-up ensures responsive command processing
- Memory not targeted (router uses consistent memory footprint)
- Includes note on custom metrics (request rate) for future enhancement

**Future Enhancement:**
When Prometheus is deployed, add request rate metrics:
```yaml
- type: Pods
  pods:
    metric:
      name: http_request_duration_seconds_count
    target:
      type: AverageValue
      averageValue: "1000m"  # Scale at 1000 req/s per pod
```

### 3. action-modules-hpa.yaml

Manages scaling for interactive action modules:
- AI Interaction (Ollama, OpenAI, MCP)
- Alias Interaction
- Shoutout Interaction
- Inventory Interaction
- Calendar Interaction
- Memories Interaction
- YouTube Music Interaction
- Spotify Interaction

**Scaling Strategy:**
- Min replicas: 2 per module
- Max replicas: 8 per module
- Metrics:
  - CPU: 70% utilization target
  - Memory: 80% utilization target
- Behavior:
  - Fast scale-up (60s stabilization)
  - Conservative scale-down (300s stabilization)

**Why these settings:**
- Action modules have variable compute requirements (AI models consume resources)
- Lower max replicas (8 vs 10) due to potential resource constraints of heavy workloads
- Both CPU and memory targets ensure resource-constrained modules scale appropriately

## Prerequisites

### Required Components

1. **Kubernetes Metrics Server**
   ```bash
   kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
   ```
   - Collects resource metrics from Kubelet
   - Required for CPU/memory-based HPA scaling

2. **Pod Resource Requests/Limits**
   - All deployments must define CPU and memory requests
   - HPA uses requests as baseline for percentage calculations
   - Current WaddleBot deployments already include these

3. **Sufficient Cluster Resources**
   - Cluster must have capacity for max replicas
   - Example: 10 router replicas × 1Gi memory limit = 10Gi reserved

### Optional Components (for Enhanced Scaling)

1. **Prometheus** - For custom metrics-based scaling
2. **Prometheus Adapter** - Bridges Prometheus to HPA
3. **KEDA (Kubernetes Event Autoscaling)** - For event-driven scaling

## Deployment

### Prerequisites Check

```bash
# Verify Metrics Server is running
kubectl get deployment metrics-server -n kube-system

# Check that pods have resource requests defined
kubectl get pods -n waddlebot -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].resources}{"\n"}{end}'
```

### Deploy HPA Configurations

```bash
# Apply all HPA configurations
kubectl apply -f k8s/hpa/receiver-modules-hpa.yaml
kubectl apply -f k8s/hpa/router-hpa.yaml
kubectl apply -f k8s/hpa/action-modules-hpa.yaml

# Or apply all at once
kubectl apply -f k8s/hpa/
```

### Verify Deployment

```bash
# List all HPAs
kubectl get hpa -n waddlebot

# View HPA status
kubectl describe hpa router-hpa -n waddlebot
kubectl describe hpa twitch-collector-hpa -n waddlebot

# Watch HPA activity
kubectl get hpa -n waddlebot --watch

# Check metrics are available
kubectl top nodes
kubectl top pods -n waddlebot
```

## Monitoring and Troubleshooting

### View HPA Status

```bash
# Current metrics and scaling state
kubectl get hpa -n waddlebot -o wide

# Detailed HPA information
kubectl describe hpa router-hpa -n waddlebot

# HPA events
kubectl get events -n waddlebot --field-selector involvedObject.kind=HorizontalPodAutoscaler
```

### Common Issues

#### 1. HPA shows "unknown" for metrics

**Problem:** Metrics Server not running or metrics not available

**Solution:**
```bash
# Check Metrics Server
kubectl get deployment metrics-server -n kube-system

# Install if missing
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# Wait for metrics to populate (takes ~1 minute)
kubectl top nodes
```

#### 2. HPA not scaling despite high utilization

**Problem:**
- Pod resource requests too high
- Stabilization window preventing scaling
- Metrics not reaching target threshold

**Diagnosis:**
```bash
# Check current utilization vs requests
kubectl describe hpa router-hpa -n waddlebot

# Check pod metrics
kubectl top pods -n waddlebot

# Check events
kubectl describe deployment router -n waddlebot
```

#### 3. Pods thrashing (constant scale up/down)

**Problem:** Stabilization windows too short or utilization oscillating

**Solution:**
- Increase stabilization window (default: 300s for scale-down, 60s for scale-up)
- Adjust percentage/pod targets
- Check application for memory leaks

#### 4. Cluster runs out of resources

**Problem:** HPA scales but cluster can't accommodate new pods

**Solution:**
```bash
# Check node capacity
kubectl describe nodes

# Check pending pods
kubectl get pods -n waddlebot --field-selector=status.phase=Pending

# Options:
# 1. Add more nodes to cluster
# 2. Lower max replicas in HPA
# 3. Increase pod resource requests to realistic values
```

## Resource Request/Limit Guidelines

HPA effectiveness depends on accurate resource requests. Current WaddleBot resources:

### Receiver Modules
- Request: CPU 100m, Memory 256Mi
- Limit: CPU 500m, Memory 512Mi
- Rationale: I/O-bound, lightweight containers

### Router Module
- Request: CPU 250m, Memory 256Mi
- Limit: CPU 1000m, Memory 1Gi
- Rationale: CPU-bound message routing, may spike on high load

### Action Modules (Interactive)
- Request: CPU 100m, Memory 256Mi
- Limit: CPU 500m, Memory 512Mi
- Baseline: lightweight by default
- Note: AI modules may need higher requests if using local LLMs

### AI Module (with Ollama)
- Request: CPU 250m, Memory 512Mi
- Limit: CPU 1000m, Memory 2Gi
- Rationale: Computationally intensive for LLM inference

**To update resource requests:**
```bash
# Edit deployment and update resources section
kubectl edit deployment ai-interaction -n waddlebot

# Or patch existing deployment
kubectl patch deployment ai-interaction -n waddlebot --type merge -p '{
  "spec": {
    "template": {
      "spec": {
        "containers": [{
          "name": "ai-interaction",
          "resources": {
            "requests": {"cpu": "250m", "memory": "512Mi"},
            "limits": {"cpu": "1000m", "memory": "2Gi"}
          }
        }]
      }
    }
  }
}'
```

## Scaling Behavior Details

### Scale-Up Behavior (Stabilization: 60s)

HPA checks metrics every 15 seconds. Scale-up proceeds if any check in the 60-second window shows utilization above target.

**Policies (applies maximum):**
- Percent: Scale by 100% (double replicas) every 30s
- Pods: Add 2 pods every 30s
- Result: Doubles replicas every 30 seconds during surge

**Example:** Router with 2 replicas at 80% CPU
- t=0s: Metrics show 80% CPU (above 70% target)
- t=30s: Scale to 4 replicas
- t=60s: Scale to 8 replicas
- t=90s: Scale to max 10 replicas

### Scale-Down Behavior (Stabilization: 300s)

HPA only considers scale-down if utilization remains below target for 5 minutes. Conservative to avoid thrashing.

**Policies (applies minimum):**
- Percent: Remove 50% of replicas per 60s
- Pods: Remove 1 pod per 60s
- Result: Removes one pod every 60s (most conservative)

**Example:** Router with 8 replicas at 20% CPU
- t=0s-300s: Monitor utilization (must stay below 70%)
- t=300s: Start scale-down if still below target
- t=360s: Remove 1 pod (7 remaining)
- t=420s: Remove 1 pod (6 remaining)
- Continues until reaching min 2 replicas

## Performance Tuning

### Adjust Utilization Targets

For more aggressive scaling (scale earlier):
```yaml
averageUtilization: 60  # Scale at 60% instead of 70%
```

For less aggressive scaling (scale later):
```yaml
averageUtilization: 80  # Scale at 80% instead of 70%
```

### Adjust Stabilization Windows

For faster response (trade-off: less stable):
```yaml
scaleUp:
  stabilizationWindowSeconds: 30  # Was 60s
scaleDown:
  stabilizationWindowSeconds: 120  # Was 300s
```

For more stability (trade-off: slower response):
```yaml
scaleUp:
  stabilizationWindowSeconds: 120  # Was 60s
scaleDown:
  stabilizationWindowSeconds: 600  # Was 300s
```

### Custom Metrics (Future)

When Prometheus is deployed:

1. Configure ServiceMonitor for metrics collection
2. Install Prometheus Adapter
3. Register custom metrics in HPA

Example for request rate:
```yaml
metrics:
- type: Pods
  pods:
    metric:
      name: http_requests_per_second
    target:
      type: AverageValue
      averageValue: "1000"  # Scale at 1000 req/s per pod
```

## Testing HPA

### Load Test Example

```bash
# Port-forward to router
kubectl port-forward svc/router-service -n waddlebot 8000:8000 &

# Generate load with Apache Bench
ab -n 10000 -c 100 http://localhost:8000/health

# Watch scaling in progress
kubectl get hpa -n waddlebot --watch
kubectl get pods -n waddlebot -l app.kubernetes.io/name=router --watch
```

### View Scaling History

```bash
# Check HPA events
kubectl describe hpa router-hpa -n waddlebot

# View metrics over time (requires Prometheus)
kubectl port-forward -n kube-system svc/prometheus 9090:9090
# Then visit http://localhost:9090/graph
```

## Best Practices

1. **Always define resource requests/limits**
   - HPA depends on requests for percentage calculations
   - Requests should reflect realistic container needs
   - Limits should allow for brief spikes

2. **Monitor and adjust metrics**
   - Track HPA scaling patterns over time
   - Adjust utilization targets based on application behavior
   - Use Prometheus for historical analysis

3. **Use PodDisruptionBudgets**
   - Configured in each HPA file
   - Prevents scale-downs during disruptions
   - Ensures availability during node maintenance

4. **Test scaling in non-production**
   - Load test before enabling in production
   - Verify min/max replicas are appropriate
   - Check cluster has sufficient resources

5. **Document configuration decisions**
   - Record why specific targets were chosen
   - Note any custom metrics added
   - Document troubleshooting steps

## Integration with Kustomize

HPAs are automatically included in Kustomization. To enable/disable:

```bash
# Include HPA in build
kustomize edit add resource k8s/hpa/

# Remove HPA from build
kustomize edit remove resource k8s/hpa/
```

## References

- [Kubernetes HPA Documentation](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [HPA Metrics API](https://kubernetes.io/docs/tasks/debug-application-cluster/resource-metrics-pipeline/)
- [HPA Behavior Reference](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/#scaling-policies)
- [Pod Disruption Budgets](https://kubernetes.io/docs/tasks/run-application/configure-pdb/)
- [KEDA Documentation](https://keda.sh/) - For event-driven autoscaling
- [Prometheus Adapter](https://github.com/kubernetes-sigs/prometheus-adapter) - For custom metrics

## Support

For issues with HPA configurations:

1. Check Metrics Server is running
2. Verify resource requests are defined
3. Review HPA events: `kubectl describe hpa <name> -n waddlebot`
4. Check pod metrics: `kubectl top pods -n waddlebot`
5. Review pod logs for resource-related errors

Last updated: 2025-12-09
WaddleBot Version: 1.0.0+
