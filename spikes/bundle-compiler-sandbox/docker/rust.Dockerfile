# Rust bundle toolchain: cargo-component (WASI 0.2 component authoring).
# Base: official rust image per devops-containers.md (rust:1.97-slim-bookworm),
# Debian bookworm underneath -- compliant with the Debian-12-only base rule.
FROM rust@sha256:2775a09d208ff0d7c1f50490c45b62db929e87ba1dcbc3f2132ac71a704bcdd3

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        bubblewrap=0.8.0-2+deb12u1 \
        pkg-config=1.8.1-1 \
        libssl-dev=3.0.20-1~deb12u2 \
    && rm -rf /var/lib/apt/lists/* && \
    bwrap --version

RUN rustup target add wasm32-wasip2 wasm32-wasip1

# cargo-component and wasm-tools pinned to exact published versions (see
# REPORT.md versions table). Building these tools themselves needs network --
# that happens here, at image-build time, never inside the bwrap sandbox.
RUN cargo install cargo-component --version 0.21.1 --locked && \
    cargo install wasm-tools --version 1.259.0 --locked && \
    cargo component --version && \
    wasm-tools --version

RUN useradd -m -u 1000 -s /bin/bash builder && \
    chown -R builder:builder /usr/local/cargo /usr/local/rustup
USER builder
WORKDIR /home/builder

# Pre-vendor this spike's bundle dependencies into $CARGO_HOME's registry
# cache at image-build time (network-enabled here) so the later per-bundle
# `cargo component build --offline` -- run against a read-only, no-network
# container -- never needs to touch crates.io. This is the practical
# equivalent of `cargo vendor` for a dependency set this small; see
# REPORT.md "Pre-vendoring recipe per language".
COPY --chown=builder:builder bundles/rust/Cargo.toml bundles/rust/Cargo.lock /home/builder/prefetch/bundle-rust/
COPY --chown=builder:builder bundles/rust/src/lib.rs /home/builder/prefetch/bundle-rust/src/lib.rs
COPY --chown=builder:builder bundles/bad-wrong-world/Cargo.toml bundles/bad-wrong-world/Cargo.lock /home/builder/prefetch/bad-wrong-world/
COPY --chown=builder:builder bundles/bad-wrong-world/src/lib.rs /home/builder/prefetch/bad-wrong-world/src/lib.rs
RUN cd /home/builder/prefetch/bundle-rust && cargo fetch --target wasm32-wasip1 --target wasm32-wasip2 && \
    cd /home/builder/prefetch/bad-wrong-world && cargo fetch --target wasm32-wasip1 && \
    rm -rf /home/builder/prefetch
