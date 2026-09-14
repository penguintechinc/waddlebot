# Q2/Q4 validation toolchain: wasm-tools (built earlier via cargo, reused
# here as a multi-stage COPY) + two pinned wasmtime CLI releases, fetched as
# official prebuilt binaries and checksum-verified, for the cross-version
# .cwasm loading test.
FROM debian@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS fetch

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        curl=7.88.1-10+deb12u15 \
        ca-certificates=20250419~deb12u1 \
        xz-utils=5.4.1-1+deb12u1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /dl

# wasmtime-cli 48.0.2 (current stable) -- digest published by GitHub's
# release API, verified below.
RUN curl -sSL -o wasmtime-new.tar.xz \
        https://github.com/bytecodealliance/wasmtime/releases/download/v48.0.2/wasmtime-v48.0.2-x86_64-linux.tar.xz && \
    echo "f2b0ad1ce9253f2f9a38793c2c42cd1cba4e90b27dc40d685eaf723dc8438d94  wasmtime-new.tar.xz" | sha256sum -c - && \
    tar xJf wasmtime-new.tar.xz && \
    mv wasmtime-v48.0.2-x86_64-linux/wasmtime wasmtime-48.0.2

# wasmtime-cli 20.0.0 (deliberately old, cross-major) -- GitHub's release API
# did not publish a digest attestation for this older asset; sha256 computed
# on download here and recorded in REPORT.md for pinning purposes.
RUN curl -sSL -o wasmtime-old.tar.xz \
        https://github.com/bytecodealliance/wasmtime/releases/download/v20.0.0/wasmtime-v20.0.0-x86_64-linux.tar.xz && \
    echo "c604a929f1039df20b4a2055496fd211a9190b493183b3311bf332be0018f0e2  wasmtime-old.tar.xz" | sha256sum -c - && \
    tar xJf wasmtime-old.tar.xz && \
    mv wasmtime-v20.0.0-x86_64-linux/wasmtime wasmtime-20.0.0

FROM debian@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        python3=3.11.2-1+b1 \
        libatomic1=12.2.0-14+deb12u1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=fetch /dl/wasmtime-48.0.2 /usr/local/bin/wasmtime-48.0.2
COPY --from=fetch /dl/wasmtime-20.0.0 /usr/local/bin/wasmtime-20.0.0
COPY --from=spike-bundle-rust:local /usr/local/cargo/bin/wasm-tools /usr/local/bin/wasm-tools

RUN chmod +x /usr/local/bin/wasmtime-48.0.2 /usr/local/bin/wasmtime-20.0.0 /usr/local/bin/wasm-tools && \
    ln -s /usr/local/bin/wasmtime-48.0.2 /usr/local/bin/wasmtime && \
    wasm-tools --version && \
    wasmtime-48.0.2 --version && \
    wasmtime-20.0.0 --version

RUN useradd -m -u 1000 -s /bin/bash builder
WORKDIR /home/builder
