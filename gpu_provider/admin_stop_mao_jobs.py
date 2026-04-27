#!/usr/bin/env python3
"""Stop detached Mao case jobs started through admin_mao_tools."""

from __future__ import annotations

import os
import subprocess
import sys


def main() -> None:
    if sys.platform != "win32":
        print("stop_mao_jobs_supported=false")
        print(f"platform={sys.platform}")
        return

    current_pid = os.getpid()
    script = rf'''
$currentPid = {current_pid}
$patterns = @(
  'build_real_multiclass_mask.py',
  'pipeline_runner.py',
  'admin_mao_tools.py'
)
$matches = Get-CimInstance Win32_Process | Where-Object {{
  if ($_.ProcessId -eq $currentPid -or -not $_.CommandLine) {{
    return $false
  }}
  $cmd = $_.CommandLine
  foreach ($pattern in $patterns) {{
    if ($cmd -like "*$pattern*") {{
      return $true
    }}
  }}
  return $false
}}
$count = 0
foreach ($proc in $matches) {{
  if ($proc.CommandLine -like '*admin_stop_mao_jobs*') {{
    continue
  }}
  Write-Host ("stopping_pid={0} command={1}" -f $proc.ProcessId, $proc.CommandLine)
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  $count += 1
}}
Write-Host ("stopped_count={0}" -f $count)
'''
    result = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        text=True,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.stdout:
        print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
    if result.stderr:
        print(result.stderr, end="" if result.stderr.endswith("\n") else "\n", file=sys.stderr)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
