"""Bridge controller pipes to a Linux controlling PTY, inside the selected namespace."""
import errno
import fcntl
import json
import os
import pty
import select
import shlex
import signal
import struct
import sys
import termios


def stop(signum, frame):
    raise SystemExit(0)


def packet(kind, data):
    return struct.pack('!BI', kind, len(data)) + data


def status(**fields):
    # Only the bridge writes controller frames. All command streams use the PTY.
    sys.stdout.buffer.write(packet(0, json.dumps(fields).encode()))
    sys.stdout.buffer.flush()


def command_bytes(size):
    result = bytearray()
    while len(result) < size:
        chunk = os.read(0, size - len(result))
        if not chunk:
            raise EOFError('Terminal command was interrupted')
        result.extend(chunk)
    return result


def run():
    size, rows, cols = struct.unpack('!IHH', command_bytes(8))
    if size > 65536:
        raise ValueError('Terminal command is too long')
    try:
        argv = shlex.split(command_bytes(size).decode())
        if not argv:
            raise ValueError('Terminal command is empty')
    except ValueError as exc:
        status(error=str(exc), startFailed=True)
        return

    # The write end closes on successful exec. A failed exec reports its error
    # here, independently of program output or a legitimate exit with code 127.
    errors, report = os.pipe2(os.O_CLOEXEC)
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
    pid, master = pty.fork()
    if pid == 0:
        os.close(errors)
        try:
            signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM})
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            os.execvp(argv[0], argv)
        except BaseException as exc:
            os.write(report, str(exc).encode(errors='replace')[:2048])
        os._exit(127)
    os.close(report)
    try:
        signal.signal(signal.SIGTERM, stop)
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM})
        with os.fdopen(errors, 'rb') as stream:
            error = stream.read()
        if error:
            status(error=error.decode(errors='replace'), startFailed=True)
            return
        status(started=True, program=argv[0])
        for fd in (0, 1, master):
            os.set_blocking(fd, False)
        frames, keys, output = bytearray(), bytearray(), bytearray()
        ended = False
        exit_code = None
        while True:
            # As namespace init we also reap orphaned background commands.
            while pid:
                exited, wait_status = os.waitpid(-1, os.WNOHANG)
                if not exited:
                    break
                if exited == pid:
                    pid = 0
                    exit_code = os.waitstatus_to_exitcode(wait_status)
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
                    elif kind == 2 and not ended:
                        rows, cols = struct.unpack('!HH', data)
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            if master in ready:
                try:
                    chunk = os.read(master, 16384)
                except OSError as exc:
                    if exc.errno != errno.EIO:
                        raise
                    chunk = b''
                if chunk:
                    output.extend(packet(1, chunk))
                else:
                    ended = True
            if master in writable and not ended:
                del keys[:os.write(master, keys)]
            if 1 in writable:
                del output[:os.write(1, output)]
            if not pid and not output and (ended or (master in readers and master not in ready)):
                os.set_blocking(1, True)
                status(exitCode=exit_code)
                return
    finally:
        if pid:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        os.close(master)


run()
