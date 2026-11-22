"""Bridge controller pipes to a Linux controlling PTY, inside the selected namespace."""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import termios


def stop(signum, frame):
    raise SystemExit(0)


def run():
    # Publish the child PID before handling a concurrent disconnect.
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
    pid, master = pty.fork()
    if pid == 0:
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM})
        os.execv('/bin/sh', ['sh', '-i'])
    try:
        signal.signal(signal.SIGTERM, stop)
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM})
        for fd in (0, 1, master):
            os.set_blocking(fd, False)
        frames, keys, output = bytearray(), bytearray(), bytearray()
        ended = False
        while True:
            # As namespace init we also reap orphaned background commands.
            while pid:
                exited, _ = os.waitpid(-1, os.WNOHANG)
                if not exited:
                    break
                if exited == pid:
                    pid = 0
            readers = [0] if len(keys) < 65536 else []
            if not ended and len(output) < 65536:
                readers.append(master)
            writers = ([1] if output else []) + ([master] if keys and not ended else [])
            ready, writable, _ = select.select(readers, writers, [], 0.2)
            if 0 in ready:
                chunk = os.read(0, 16384)
                if not chunk:
                    return
                frames.extend(chunk)
                while len(frames) >= 5:
                    kind, size = struct.unpack_from('!BI', frames)
                    if size > 65536:
                        raise ValueError('invalid frame size')
                    if len(frames) < size + 5:
                        break
                    data = frames[5:5 + size]
                    del frames[:5 + size]
                    if kind == 1:
                        keys.extend(data)
                    elif kind == 2:
                        rows, cols = struct.unpack('!HH', data)
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            if master in ready:
                try:
                    chunk = os.read(master, 16384)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    chunk = b''
                output.extend(chunk)
                ended = not chunk
            if master in writable and not ended:
                del keys[:os.write(master, keys)]
            if 1 in writable:
                del output[:os.write(1, output)]
            if not output and (ended or (not pid and master not in ready)):
                return
    finally:
        if pid:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        os.close(master)


run()
