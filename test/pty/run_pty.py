#!/usr/bin/env python3
"""Run one command in a real PTY and replay a deterministic input schedule."""

import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def main() -> int:
    if len(sys.argv) < 4:
        raise SystemExit("usage: run_pty.py <cwd> <schedule-json> <command> [args...]")
    cwd = sys.argv[1]
    schedule = json.loads(sys.argv[2])
    command = sys.argv[3:]
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=os.environ.copy(),
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave)
    started = time.monotonic()
    due = 0.0
    next_input = 0
    shutdown_at = sum(item["afterMs"] for item in schedule) / 1000.0 + (
        2.5 if not schedule else 1.0
    )
    second_interrupt_at = shutdown_at + 0.15
    deadline = second_interrupt_at + 2.0
    sent_first_interrupt = False
    sent_second_interrupt = False
    terminated_by_harness = False

    try:
        while True:
            elapsed = time.monotonic() - started
            while next_input < len(schedule):
                due += schedule[next_input]["afterMs"] / 1000.0
                if elapsed < due:
                    due -= schedule[next_input]["afterMs"] / 1000.0
                    break
                os.write(master, schedule[next_input]["data"].encode("utf-8"))
                next_input += 1
            if elapsed >= shutdown_at and not sent_first_interrupt:
                os.write(master, b"\x03")
                sent_first_interrupt = True
            if elapsed >= second_interrupt_at and not sent_second_interrupt:
                os.write(master, b"\x03")
                sent_second_interrupt = True

            readable, _, _ = select.select([master], [], [], 0.04)
            if readable:
                try:
                    output = os.read(master, 65536)
                except OSError:
                    output = b""
                if output:
                    sys.stdout.buffer.write(output)
                    sys.stdout.buffer.flush()
            if process.poll() is not None:
                break
            if elapsed >= deadline:
                os.killpg(process.pid, signal.SIGTERM)
                terminated_by_harness = True
                break
    finally:
        os.close(master)

    try:
        return_code = process.wait(timeout=1)
        if terminated_by_harness and return_code == -signal.SIGTERM:
            return 0
        return return_code
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        return process.wait(timeout=1)


if __name__ == "__main__":
    raise SystemExit(main())
