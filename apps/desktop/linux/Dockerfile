# Linux build of the MepMail desktop app (AppImage, .deb, .rpm), local and
# reproducible: Ubuntu 22.04 keeps glibc old enough for the AppImage to run on
# current distributions. Used by linux/build.sh; nothing here runs on the VPS.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl wget file ca-certificates git pkg-config rsync \
      libssl-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev \
      libwebkit2gtk-4.1-dev libdbus-1-dev patchelf rpm \
      xvfb imagemagick dbus-x11 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable

# linuxdeploy (AppImage) runs without FUSE inside a container; its strip is
# older than the toolchain, so the bundler leaves binaries unstripped there.
ENV APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true

WORKDIR /work
