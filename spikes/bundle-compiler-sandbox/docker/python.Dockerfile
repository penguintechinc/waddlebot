# Python bundle toolchain: componentize-py.
# Base per devops-containers.md Python row; Debian bookworm underneath.
FROM python@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e

# componentize-py pinned to an exact published version (see REPORT.md
# versions table). Installed here (network-enabled image build); the
# sandboxed componentize step later runs with --network none.
RUN pip install --no-cache-dir --root-user-action=ignore componentize-py==0.25.1 && \
    componentize-py --version

RUN useradd -m -u 1000 -s /bin/bash builder
WORKDIR /home/builder
