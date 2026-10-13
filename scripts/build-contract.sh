#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../contracts"
cargo build --release --target riscv64imac-unknown-none-elf -p pilot-session-lock
mkdir -p build
llvm-objcopy --strip-all target/riscv64imac-unknown-none-elf/release/pilot-session-lock build/pilot-session-lock
