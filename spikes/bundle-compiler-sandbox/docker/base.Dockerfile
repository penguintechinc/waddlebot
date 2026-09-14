# Base image shared by all three toolchain images.
# Pinned base per devops-containers.md (Debian 12 bookworm, never Ubuntu/Alpine).
# Digest recorded in REPORT.md / versions.txt.
FROM debian@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

# Exact bubblewrap version pinned via apt (Debian bookworm: 0.8.0-2+deb12u1).
# apt-get install with an exact version string fails closed if the mirror ever
# serves a different build, which is what we want for a hermetic toolchain image.
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        bubblewrap=0.8.0-2+deb12u1 \
        ca-certificates=20250419~deb12u1 \
        curl=7.88.1-10+deb12u15 \
    && rm -rf /var/lib/apt/lists/* && \
    bwrap --version

# See REPORT.md "Nested bwrap container settings" for the full investigation
# trail (attempted: --cap-add alone, setcap file capabilities on the bwrap
# binary, chmod u+s setuid-root -- none worked as a non-root outer container
# user on this host's Ubuntu 24.04 AppArmor `unprivileged_userns` mitigation,
# which applies at the host kernel regardless of the container's base distro).
#
# ROOT EXCEPTION (needs approval): the OUTER wrapper container must run as
# uid 0 with --cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt
# apparmor=unconfined --security-opt seccomp=unconfined --security-opt
# systempaths=unconfined (or --privileged) for nested bwrap to succeed here.
# bwrap itself still drops all of that before exec'ing the untrusted build
# toolchain -- only the wrapper needs root, never the compiled bundle's build
# step. This is a rootless-containers exception per devops-containers.md and
# needs explicit human sign-off before the real compiler service adopts it;
# flagged, not silently applied to production.
RUN useradd -m -u 1000 -s /bin/bash builder
WORKDIR /home/builder
