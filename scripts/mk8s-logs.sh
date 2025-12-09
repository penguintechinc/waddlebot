#!/bin/bash
# Get logs from k8s pods and write to files

OUTPUT_DIR="/tmp/mk8s-logs"
mkdir -p "$OUTPUT_DIR"

echo "Fetching logs..."

microk8s kubectl logs -n waddlebot -l app=hub --tail=100 > "$OUTPUT_DIR/hub.log" 2>&1
microk8s kubectl logs -n waddlebot -l app=openwhisk --tail=100 > "$OUTPUT_DIR/openwhisk.log" 2>&1
microk8s kubectl logs -n waddlebot -l app=openwhisk-action --tail=100 > "$OUTPUT_DIR/openwhisk-action.log" 2>&1
microk8s kubectl logs -n waddlebot -l app=lambda-action --tail=100 > "$OUTPUT_DIR/lambda-action.log" 2>&1
microk8s kubectl logs -n waddlebot -l app=gcp-functions-action --tail=100 > "$OUTPUT_DIR/gcp-functions-action.log" 2>&1

microk8s kubectl get pods -n waddlebot -o wide > "$OUTPUT_DIR/pods.txt" 2>&1
microk8s kubectl describe pods -n waddlebot > "$OUTPUT_DIR/describe.txt" 2>&1

echo "Logs written to $OUTPUT_DIR"
ls -la "$OUTPUT_DIR"
