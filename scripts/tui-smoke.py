#!/usr/bin/env python3
"""Exercise the official terminal UI through a real POSIX pseudo-terminal."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

pid, terminal = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], {**os.environ, "TERM": "xterm-256color"})
fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 110, 0, 0))
transcript = b""
sent = False
finished = False
status = None
deadline = time.monotonic() + 15
try:
    while time.monotonic() < deadline:
        if select.select([terminal], [], [], 0.1)[0]:
            try:
                chunk = os.read(terminal, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            transcript = (transcript + chunk)[-200000:]
        if not sent and b"Waiting for input" in transcript:
            os.write(terminal, b"[chat-only] Terminal integration smoke")
            time.sleep(0.05)
            os.write(terminal, b"\n")
            sent = True
        if not finished and b"Done" in transcript and b"Deterministic demo finished" in transcript:
            os.write(terminal, b"\x1b")
            finished = True
        waited, status = os.waitpid(pid, os.WNOHANG)
        if waited:
            break
    else:
        raise TimeoutError("Terminal UI did not complete and exit within 15 seconds")
    if status is None or not os.WIFEXITED(status):
        _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    if code != 0 or not finished:
        raise RuntimeError(f"Terminal smoke failed: exit={code}, completed={finished}")
    print(json.dumps({"completed": finished, "exit_code": code}))
except Exception:
    sys.stderr.write(transcript.decode(errors="replace")[-10000:])
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    raise
finally:
    os.close(terminal)
