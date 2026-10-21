#!/usr/bin/env python3
"""
修正 ImmortalWrt SDK 生成的 Config-build.in 里的 BPF 工具链配置。

背景（25.12.2 SDK）:
  SDK 的 Config.in 并不 source toolchain/Config.in，BPF 相关符号来自
  convert-config.pl 生成的 Config-build.in。生成结果是普通（无 prompt）的
  bool + default y，例如:

      config USE_LLVM_BUILD
          bool
          default y

  Kconfig 对无 prompt 的符号会忽略 .config 里的值，所以：
    - 即使在 .config 写 CONFIG_USE_LLVM_PREBUILT=y，也会被丢弃；
    - USE_LLVM_BUILD 始终为 y，include/bpf.mk 最终用
      STAGING_DIR_HOST/llvm-bpf 并从源码编 LLVM（极慢）。

  这个脚本删掉这些强制默认块，并重新声明三个我们需要、且默认 y 的符号：
      HAS_BPF_TOOLCHAIN / NEED_BPF_TOOLCHAIN / USE_LLVM_PREBUILT
  这样 include/bpf.mk 会走 $(TOPDIR)/llvm-bpf/bin 的预编译 clang。

用法:
  python3 patch-sdk-config.py <sdk>/Config-build.in
"""

import re
import sys

DROP_PREFIXES = (
    "BPF_TOOLCHAIN_",
    "USE_LLVM_",
    "ALL_",
    "HAS_BPF_TOOLCHAIN",
    "NEED_BPF_TOOLCHAIN",
)
DROP_EXACT = {"ALL", "BUILDBOT"}

FORCED = """

# --- daed build: force prebuilt LLVM BPF toolchain (llvm-bpf/) ---
config HAS_BPF_TOOLCHAIN
	bool
	default y

config NEED_BPF_TOOLCHAIN
	bool
	default y

config USE_LLVM_PREBUILT
	bool "Use prebuilt LLVM BPF toolchain (llvm-bpf/)"
	default y
"""


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <Config-build.in>", file=sys.stderr)
        return 1

    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        text = f.read()

    parts = re.split(r"(?m)^(?=config\s)", text)
    kept, dropped = [], []
    for part in parts:
        m = re.match(r"config\s+(\S+)", part)
        if m:
            name = m.group(1)
            if name in DROP_EXACT or name.startswith(DROP_PREFIXES):
                dropped.append(name)
                continue
        kept.append(part)

    with open(path, "w", encoding="utf-8") as f:
        f.write("".join(kept) + FORCED)

    print(f"patched {path}")
    if dropped:
        print("dropped forced defaults:", ", ".join(dropped))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
