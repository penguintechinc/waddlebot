# HPA Deployment Guide

Quick-start guide for deploying WaddleBot's Horizontal Pod Autoscaler configurations.

## Prerequisites Checklist

- [ ] Kubernetes cluster running (1.18+)
- [ ] kubectl configured and connected to cluster
- [ ] Metrics Server installed in cluster
- [ ] All WaddleBot deployments have resource requests/limits defined
- [ ] Cluster has capacity for max replicas (example: 10 router pods × 1Gi = 10Gi)

## Step 1: Verify Metrics Server

The HPA requires the Metrics Server to collect CPU and memory metrics.

```bash
# Check if Metrics Server is running
kubectl get deployment metrics-server -n kube-system

# If not found, install it
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# Wait for Metrics Server to be ready
kubectl wait --for=condition=available --timeout=300s \
  deployment/metrics-server -n kube-system
```

Verify metrics are available:
```bash
# Should show node metrics
kubectl top nodes

# Should show pod metrics (wait ~1 minute after Metrics Server deploys)
kubectl top pods -n waddlebot
```

## Step 2: Verify Deployments Have Resources Defined

HPA scales based on resource requests. Verify all deployments are properly configured:

```bash
# Check router deployment
kubectl get deployment router -n waddlebot -o jsonpath='{.spec.template.spec.containers[0].resources}'

# Check all deployments
kubectl get all -n waddlebot -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].resources}{"\n"}{end}'
```

All containers should show requests and limits. If missing, update deployments before proceeding.

## Step 3: Deploy HPA Configurations

### Option A: Deploy All HPAs

```bash
# Apply all HPA configurations
kubectl apply -f k8s/hpa/

# Verify HPAs are created
kubectl get hpa -n waddlebot
```

### Option B: Deploy Specific HPAs

```bash
# Deploy only receiver module HPAs
kubectl apply -f k8s/hpa/receiver-modules-hpa.yaml

# Deploy only router HPA
kubectl apply -f k8s/hpa/router-hpa.yaml

# Deploy only action module HPAs
kubectl apply -f k8s/hpa/action-modules-hpa.yaml
```

## Step 4: Verify HPA Status

```bash
# List all HPAs
kubectl get hpa -n waddlebot

# Expected output:
# NAME                        REFERENCE                         TARGETS                    MINPODS MAXPODS REPLICAS AGE
# ai-interaction-hpa          Deployment/ai-interaction         30%/70%, 20%/80%           2       8       2        10s
# alias-interaction-hpa       Deployment/alias-interaction      25%/70%, 15%/80%           2       8       2        10s
# discord-collector-hpa       Deployment/discord-collector      45%/70%, 35%/80%           2       10      2        10s
# ...

# Watch HPA activity
kubectl get hpa -n waddlebot --watch

# Get detailed status
kubectl describe hpa router-hpa -n waddlebot
```

## Step 5: Verify Scaling Behavior (Optional)

Test HPA scaling with a load test:

```bash
# Port-forward to router
kubectl port-forward -n waddlebot svc/router-service 8000:8000 &
PF_PID=$!

# Generate load (requires Apache Bench installed)
# Scale to trigger > 70% CPU
ab -n 50000 -c 100 http://localhost:8000/health

# Watch pods scaling
kubectl get pods -n waddlebot -l app.kubernetes.io/name=router --watch

# Watch HPA metrics
kubectl get hpa router-hpa -n waddlebot --watch

# Clean up
kill $PF_PID
```

## Step 6: Configure Kustomization (Optional)

To include HPAs in your Kustomization build:

```bash
# Edit main kustomization.yaml
nano k8s/manifests/kustomization.yaml

# Add to resources section:
# - ../hpa/
```

Or use kustomize command:
```bash
cd k8s/manifests
kustomize edit add resource ../hpa/
```

## Step 7: Monitor Over Time

Set up monitoring for HPA behavior:

```bash
# View HPA scaling events
kubectl get events -n waddlebot --field-selector involvedObject.kind=HorizontalPodAutoscaler --sort-by='.lastTimestamp'

# Check HPA current metrics
kubectl get hpa -n waddlebot -o wide

# View pod counts over time
kubectl get pods -n waddlebot -l component=receiver --watch
```

## Common Deployment Issues

### Issue: HPAs show "unknown" for metrics

**Cause:** Metrics Server not ready or metrics haven't been collected yet

**Fix:**
```bash
# Wait for Metrics Server
kubectl wait --for=condition=available --timeout=300s \
  deployment/metrics-server -n kube-system

# Wait ~1 minute for metrics collection
sleep 60

# Verify metrics available
kubectl top nodes
kubectl top pods -n waddlebot
```

### Issue: HPAs show 0 targets

**Cause:** Pod resource requests not defined

**Fix:**
```bash
# Edit deployment and add resources
kubectl edit deployment <deployment-name> -n waddlebot

# Add to containers[].resources:
resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

### Issue: Pods stay at minReplicas despite high load

**Cause:** Utilization not reaching threshold, or stabilization window active

**Fix:**
```bash
# Check current utilization
kubectl top pods -n waddlebot

# Check HPA status and events
kubectl describe hpa router-hpa -n waddlebot

# If in stabilization window, wait 60-300 seconds depending on configuration
# Then check again
```

## Rollback (If Needed)

To remove HPA configurations:

```bash
# Delete all HPAs
kubectl delete hpa -n waddlebot -l app.kubernetes.io/part-of=waddlebot

# Or delete specific HPA
kubectl delete hpa router-hpa -n waddlebot

# Deployments will revert to static replica counts
# You may want to manually set replicas:
kubectl scale deployment router -n waddlebot --replicas=2
```

## Next Steps

1. **Monitor HPA behavior** for 24-48 hours
   - Track scaling patterns
   - Note any unexpected behavior
   - Review metrics in logs

2. **Tune if needed**
   - Adjust utilization targets if scaling too aggressive/conservative
   - Adjust stabilization windows based on traffic patterns
   - Update resource requests based on actual usage

3. **Add custom metrics** (optional, requires Prometheus)
   - Deploy Prometheus
   - Deploy Prometheus Adapter
   - Add request rate metrics to HPAs
   - See README.md for details

4. **Set up monitoring/alerting**
   - Create alerts for failed scaling
   - Monitor HPA events
   - Track cost impact of additional replicas

## Validation Checklist

- [ ] Metrics Server deployed and reporting metrics
- [ ] All pods show CPU/memory in `kubectl top pods`
- [ ] HPAs created and showing target metrics
- [ ] PodDisruptionBudgets created (for availability)
- [ ] Scaling behavior tested with load
- [ ] Monitoring/alerting configured
- [ ] Documentation updated with decisions made
- [ ] Team trained on HPA operations

## Quick Reference Commands

```bash
# Check HPA status
kubectl get hpa -n waddlebot

# Watch HPA scaling
kubectl get hpa -n waddlebot --watch

# View HPA metrics
kubectl get hpa -n waddlebot -o wide

# Detailed HPA info
kubectl describe hpa <hpa-name> -n waddlebot

# Check Metrics Server
kubectl get deployment metrics-server -n kube-system

# View pod metrics
kubectl top pods -n waddlebot

# View pod counts by label
kubectl get pods -n waddlebot -L component

# View HPA events
kubectl get events -n waddlebot --field-selector involvedObject.kind=HorizontalPodAutoscaler

# Delete specific HPA
kubectl delete hpa router-hpa -n waddlebot

# Delete all HPAs
kubectl delete hpa -n waddlebot -A
```

## Support Resources

- **HPA Documentation:** https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/
- **Metrics Server:** https://github.com/kubernetes-sigs/metrics-server
- **WaddleBot HPA README:** See `k8s/hpa/README.md`

---

**Last Updated:** 2025-12-09
**WaddleBot Version:** 1.0.0+
**Kubernetes Version:** 1.18+
