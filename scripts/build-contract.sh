#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../contracts"
cargo build --release --target riscv64imac-unknown-none-elf -p pilot-session-lock -p pilot-delegation-lock -p pilot-sponsored-session-lock -p pilot-sponsored-delegation-lock -p pilot-account-lock -p pilot-passkey-lock -p pilot-wallet-session-lock -p pilot-wallet-general-lock
mkdir -p build
llvm-objcopy --strip-all target/riscv64imac-unknown-none-elf/release/pilot-session-lock build/pilot-session-lock
llvm-objcopy --strip-all target/riscv64imac-unknown-none-elf/release/pilot-delegation-lock build/pilot-delegation-lock

llvm-objcopy --strip-all target/riscv64imac-unknown-none-elf/release/pilot-sponsored-session-lock build/pilot-sponsored-session-lock
llvm-objcopy --strip-all target/riscv64imac-unknown-none-elf/release/pilot-sponsored-delegation-lock build/pilot-sponsored-delegation-lock

llvm-objcopy --strip-all target/riscv64imac-unknown-none-elf/release/pilot-account-lock build/pilot-account-lock
llvm-objcopy --strip-all target/riscv64imac-unknown-none-elf/release/pilot-passkey-lock build/pilot-passkey-lock
llvm-objcopy --strip-all target/riscv64imac-unknown-none-elf/release/pilot-wallet-session-lock build/pilot-wallet-session-lock
llvm-objcopy --strip-all target/riscv64imac-unknown-none-elf/release/pilot-wallet-general-lock build/pilot-wallet-general-lock
