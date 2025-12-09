# WaddleBot HPA Quick Reference Card

## Deploy HPAs
```bash
kubectl apply -f k8s/hpa/
```

## Check Status
```bash
kubectl get hpa -n waddlebot
kubectl get hpa -n waddlebot -o wide
kubectl describe hpa router-hpa -n waddlebot
```

## Watch Scaling
```bash
kubectl get hpa -n waddlebot --watch
kubectl get pods -n waddlebot -l app.kubernetes.io/name=router --watch
```

## Verify Metrics Available
```bash
kubectl top nodes
kubectl top pods -n waddlebot
```

## Check Metrics Server
```bash
kubectl get deployment metrics-server -n kube-system
```

## View HPA Events
```bash
kubectl get events -n waddlebot --field-selector involvedObject.kind=HorizontalPodAutoscaler
```

## Delete HPAs
```bash
kubectl delete hpa -n waddlebot -A
# or specific:
kubectl delete hpa router-hpa -n waddlebot
```

## Scale Test Load
```bash
# Port forward
kubectl port-forward -n waddlebot svc/router-service 8000:8000 &

# Generate load
ab -n 50000 -c 100 http://localhost:8000/health

# Watch scaling
kubectl get hpa -n waddlebot --watch
```

---

## HPA Configuration Targets

| Module | Min | Max | CPU | Memory |
|--------|-----|-----|-----|--------|
| Twitch Receiver | 2 | 10 | 70% | 80% |
| Discord Receiver | 2 | 10 | 70% | 80% |
| Slack Receiver | 2 | 10 | 70% | 80% |
| Router | 2 | 10 | 70% | - |
| AI Action | 2 | 8 | 70% | 80% |
| Alias Action | 2 | 8 | 70% | 80% |
| Shoutout Action | 2 | 8 | 70% | 80% |
| Inventory Action | 2 | 8 | 70% | 80% |
| Calendar Action | 2 | 8 | 70% | 80% |
| Memories Action | 2 | 8 | 70% | 80% |
| YouTube Music Action | 2 | 8 | 70% | 80% |
| Spotify Action | 2 | 8 | 70% | 80% |

---

## Scaling Behavior

**Scale Up:** 60s stabilization, 100% increase every 30s
**Scale Down:** 300s stabilization, remove 1 pod every 60s

---

## Troubleshooting Checklist

- [ ] Metrics Server running: `kubectl get deployment metrics-server -n kube-system`
- [ ] Metrics available: `kubectl top pods -n waddlebot`
- [ ] HPAs created: `kubectl get hpa -n waddlebot`
- [ ] HPAs showing metrics: `kubectl describe hpa <name> -n waddlebot`
- [ ] Pods have resource requests defined
- [ ] Cluster has capacity for max replicas

---

## Resources

- Full Documentation: `k8s/hpa/README.md`
- Deployment Guide: `k8s/hpa/DEPLOYMENT_GUIDE.md`
- Kubernetes HPA: https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/
