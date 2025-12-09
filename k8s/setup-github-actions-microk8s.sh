#!/bin/bash
#
# GitHub Actions Setup for MicroK8s
#
# This script configures your MicroK8s cluster to work with GitHub Actions CI/CD.
# It creates a service account with namespace-scoped permissions and generates
# the kubeconfig that GitHub Actions will use to deploy to your cluster.
#
# Usage:
#   ./setup-github-actions-microk8s.sh [OPTIONS]
#
# Options:
#   --namespace NAME    Use custom namespace (default: waddlebot)
#   --help              Show this help message
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Default configuration
NAMESPACE="waddlebot"
SERVICE_ACCOUNT="github-actions"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${CYAN}==>${NC} $1"
}

show_help() {
    grep '^#' "$0" | grep -v '#!/bin/bash' | sed 's/^# //' | sed 's/^#//'
    exit 0
}

check_prerequisites() {
    log_step "Checking prerequisites..."

    # Check if MicroK8s is installed
    if ! command -v microk8s &> /dev/null; then
        log_error "MicroK8s is not installed. Please install MicroK8s first."
        exit 1
    fi

    # Check if MicroK8s is running
    if ! microk8s status --wait-ready --timeout 10 &> /dev/null; then
        log_error "MicroK8s is not running or not ready. Please start MicroK8s first."
        exit 1
    fi

    # Check if kubectl works
    if ! microk8s kubectl version &> /dev/null; then
        log_error "Cannot connect to MicroK8s cluster. Please check your installation."
        exit 1
    fi

    log_success "Prerequisites check passed"
}

create_namespace() {
    log_step "Creating namespace if it doesn't exist..."

    if microk8s kubectl get namespace "$NAMESPACE" &> /dev/null; then
        log_info "Namespace '$NAMESPACE' already exists"
    else
        microk8s kubectl create namespace "$NAMESPACE"
        log_success "Created namespace '$NAMESPACE'"
    fi
}

create_service_account() {
    log_step "Creating service account for GitHub Actions..."

    # Create service account
    cat <<EOF | microk8s kubectl apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: $SERVICE_ACCOUNT
  namespace: $NAMESPACE
EOF

    log_success "Created service account '$SERVICE_ACCOUNT'"
}

create_role() {
    log_step "Creating role with deployment permissions..."

    # Create role with necessary permissions for deployment
    cat <<EOF | microk8s kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: $SERVICE_ACCOUNT-role
  namespace: $NAMESPACE
rules:
  # Deployments
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets", "statefulsets", "daemonsets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # Services
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # ConfigMaps and Secrets
  - apiGroups: [""]
    resources: ["configmaps", "secrets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # Pods (for logs and exec)
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch", "create", "delete"]
  # PVCs
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # Ingress
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # Jobs
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  # Events (for debugging)
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["get", "list", "watch"]
EOF

    log_success "Created role with deployment permissions"
}

create_role_binding() {
    log_step "Binding role to service account..."

    cat <<EOF | microk8s kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: $SERVICE_ACCOUNT-binding
  namespace: $NAMESPACE
subjects:
  - kind: ServiceAccount
    name: $SERVICE_ACCOUNT
    namespace: $NAMESPACE
roleRef:
  kind: Role
  name: $SERVICE_ACCOUNT-role
  apiGroup: rbac.authorization.k8s.io
EOF

    log_success "Bound role to service account"
}

create_token_secret() {
    log_step "Creating token secret for service account..."

    cat <<EOF | microk8s kubectl apply -f -
apiVersion: v1
kind: Secret
metadata:
  name: $SERVICE_ACCOUNT-token
  namespace: $NAMESPACE
  annotations:
    kubernetes.io/service-account.name: $SERVICE_ACCOUNT
type: kubernetes.io/service-account-token
EOF

    # Wait for token to be populated
    log_info "Waiting for token to be populated..."
    sleep 3

    log_success "Created token secret"
}

generate_kubeconfig() {
    log_step "Generating kubeconfig for GitHub Actions..."

    # Get service account token
    TOKEN=$(microk8s kubectl get secret $SERVICE_ACCOUNT-token \
        -n $NAMESPACE \
        -o jsonpath='{.data.token}' | base64 -d)

    if [ -z "$TOKEN" ]; then
        log_error "Failed to extract service account token"
        exit 1
    fi

    # Get cluster CA certificate
    CA_CERT=$(microk8s kubectl get secret $SERVICE_ACCOUNT-token \
        -n $NAMESPACE \
        -o jsonpath='{.data.ca\.crt}')

    # Get cluster endpoint
    CLUSTER_ENDPOINT=$(microk8s kubectl config view --raw \
        -o jsonpath='{.clusters[0].cluster.server}')

    # Generate kubeconfig
    cat > /tmp/github-actions-kubeconfig.yaml <<EOF
apiVersion: v1
kind: Config
clusters:
- name: microk8s-cluster
  cluster:
    certificate-authority-data: $CA_CERT
    server: $CLUSTER_ENDPOINT
contexts:
- name: github-actions-context
  context:
    cluster: microk8s-cluster
    namespace: $NAMESPACE
    user: $SERVICE_ACCOUNT
current-context: github-actions-context
users:
- name: $SERVICE_ACCOUNT
  user:
    token: $TOKEN
EOF

    log_success "Generated kubeconfig"
}

output_secrets() {
    log_step "Generating GitHub Secrets..."

    # Base64 encode the kubeconfig
    KUBE_CONFIG_DATA=$(cat /tmp/github-actions-kubeconfig.yaml | base64 -w 0)

    # Get cluster endpoint
    CLUSTER_ENDPOINT=$(microk8s kubectl config view --raw \
        -o jsonpath='{.clusters[0].cluster.server}')

    echo ""
    echo "=================================================================="
    echo "  GitHub Actions Secrets for MicroK8s"
    echo "=================================================================="
    echo ""
    echo "Add these secrets to your GitHub repository:"
    echo "  1. Go to your repository on GitHub"
    echo "  2. Click Settings > Secrets and variables > Actions"
    echo "  3. Click 'New repository secret'"
    echo "  4. Add each secret below"
    echo ""
    echo "------------------------------------------------------------------"
    echo ""
    echo "Secret Name: KUBE_CONFIG_DATA"
    echo "Description: Base64-encoded kubeconfig for cluster access"
    echo ""
    echo "Value (copy everything below):"
    echo "$KUBE_CONFIG_DATA"
    echo ""
    echo "------------------------------------------------------------------"
    echo ""
    echo "Secret Name: K8S_NAMESPACE"
    echo "Description: Target namespace for deployment"
    echo ""
    echo "Value:"
    echo "$NAMESPACE"
    echo ""
    echo "------------------------------------------------------------------"
    echo ""
    echo "Secret Name: K8S_CLUSTER_ENDPOINT"
    echo "Description: Kubernetes API server endpoint"
    echo ""
    echo "Value:"
    echo "$CLUSTER_ENDPOINT"
    echo ""
    echo "------------------------------------------------------------------"
    echo ""
    echo "Secret Name: K8S_CLUSTER_TYPE"
    echo "Description: Cluster type for deployment strategy"
    echo ""
    echo "Value:"
    echo "microk8s"
    echo ""
    echo "=================================================================="
    echo ""
    log_success "Secrets generated successfully!"
    echo ""
    log_info "Next steps:"
    echo "  1. Copy the secrets above and add them to your GitHub repository"
    echo "  2. Ensure your GitHub Actions workflow is configured to use GHCR"
    echo "  3. Push to main branch to trigger deployment"
    echo ""
    log_warning "Important: The kubeconfig is stored temporarily at:"
    echo "  /tmp/github-actions-kubeconfig.yaml"
    echo ""
    echo "You can test it locally with:"
    echo "  kubectl --kubeconfig=/tmp/github-actions-kubeconfig.yaml get pods -n $NAMESPACE"
    echo ""
}

verify_setup() {
    log_step "Verifying setup..."

    # Test the generated kubeconfig
    if kubectl --kubeconfig=/tmp/github-actions-kubeconfig.yaml \
        get pods -n $NAMESPACE &> /dev/null; then
        log_success "Kubeconfig is valid and working"
    else
        log_warning "Could not verify kubeconfig (namespace may be empty)"
    fi

    # Check service account permissions
    if kubectl --kubeconfig=/tmp/github-actions-kubeconfig.yaml \
        auth can-i create deployments -n $NAMESPACE &> /dev/null; then
        log_success "Service account has deployment permissions"
    else
        log_error "Service account does not have deployment permissions"
        exit 1
    fi
}

cleanup_temp_files() {
    log_step "Cleaning up..."

    # Keep the kubeconfig for user verification
    log_info "Temporary kubeconfig saved to /tmp/github-actions-kubeconfig.yaml"
    log_info "You can delete it after adding secrets to GitHub"
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --namespace)
            NAMESPACE="$2"
            shift 2
            ;;
        --help)
            show_help
            ;;
        *)
            log_error "Unknown option: $1"
            show_help
            ;;
    esac
done

# Main execution
main() {
    echo ""
    log_info "=== GitHub Actions Setup for MicroK8s ==="
    echo ""

    check_prerequisites
    create_namespace
    create_service_account
    create_role
    create_role_binding
    create_token_secret
    generate_kubeconfig
    verify_setup
    output_secrets
    cleanup_temp_files

    echo ""
    log_success "=== Setup Complete! ==="
    echo ""
}

main
