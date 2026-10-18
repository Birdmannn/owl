#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../contracts"
cargo build --release --target riscv64imac-unknown-none-elf -p pilot-session-lock -p pilot-delegation-lock -p pilot-sponsored-session-lock -p pilot-sponsored-delegation-lock
mkdir -p build
llvm-objcopy --strip-all target/riscv64imac-unknown-none-elf/release/pilot-session-lock build/pilot-session-lock
llvm-objcopy --strip-all target/riscv64imac-unknown-none-elf/release/pilot-delegation-lock build/pilot-delegation-lock

llvm-objcopy --strip-all target/riscv64imac-unknown-none-elf/release/pilot-sponsored-session-lock build/pilot-sponsored-session-lock
llvm-objcopy --strip-all target/riscv64imac-unknown-none-elf/release/pilot-sponsored-delegation-lock build/pilot-sponsored-delegation-lock
