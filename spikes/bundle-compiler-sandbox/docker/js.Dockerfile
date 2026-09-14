# JS/TS bundle toolchain: jco (wraps @bytecodealliance/componentize-js).
# Base per devops-containers.md Node.js row; Debian bookworm underneath.
FROM node@sha256:cd9f682fa2885cd1056e830424764158570061c59736a1da836bc3d73df095ae

# jco pinned to an exact published version (see REPORT.md versions table).
# Installed here (network-enabled image build); the sandboxed componentize
# step later runs with --network none against this already-installed CLI.
RUN npm install -g --no-fund --no-audit @bytecodealliance/jco@1.34.0 && \
    jco --version

# node's official image already ships a uid-1000 "node" user; reuse it.
WORKDIR /home/node
