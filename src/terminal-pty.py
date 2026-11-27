"""Bridge controller frames to a controlling PTY or to separate process pipes."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import shlex
import signal
import stat
import struct
import sys
import termios


def stop(signum, frame):
    raise SystemExit(0)


def packet(kind, data):
    return struct.pack('!BI', kind, len(data)) + data


def status(**fields):
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


def verify_mounts(expected):
    # Confirm overlays at their exact destinations before starting user code.
    # mountinfo escapes whitespace and backslash as three octal digits.
    mounts = {}
    with open('/proc/self/mountinfo', 'rb') as table:
        for line in table:
            before, after = line.split(b' - ', 1)
            fields = before.split()
            name = re.sub(rb'\\([0-7]{3})', lambda m: bytes([int(m[1], 8)]), fields[4])
            mounts[os.fsdecode(name)] = (fields[5].split(b','), after.split()[0])
    for entry in expected:
        path = entry['path']
        flags, filesystem = mounts.get(path, ([], None))
        mode = b'rw' if entry['mode'] == 'rw' else b'ro'
        if os.path.realpath(path) != path or mode not in flags:
            raise ValueError('Terminal mount destination changed')
        if entry['mode'] == 'mask-dir' and filesystem != b'tmpfs':
            raise ValueError('Invalid terminal directory mask')
        if entry['mode'] == 'mask-file':
            node = os.lstat(path)
            if not stat.S_ISCHR(node.st_mode) or node.st_rdev != os.makedev(1, 3):
                raise ValueError('Invalid terminal file mask')
        if 'inode' in entry:
            node = os.lstat(path)
            if node.st_dev != int(entry['dev']) or node.st_ino != int(entry['inode']):
                raise ValueError('Terminal mount source changed')


def run():
    size, rows, cols = struct.unpack('!IHH', command_bytes(8))
    if size > 65536:
        raise ValueError('Terminal command is too long')
    try:
        launch = json.loads(command_bytes(size))
        if launch.get('verifyMounts'):
            verify_mounts(launch['verifyMounts'])
        argv = launch.get('argv')
        if argv is None:
            argv = shlex.split(launch['command'])
        if not argv:
            raise ValueError('Terminal command is empty')
    except (OSError, ValueError) as exc:
        status(error=str(exc), startFailed=True)
        return

    if 'cwd' in launch:
        try:
            os.chdir(launch['cwd'])
        except (FileNotFoundError, NotADirectoryError, PermissionError):
            pass  # Keep the fresh /tmp if the requested cwd isn't mounted.

    # The write end closes on successful exec. A failed exec reports its error
    # here, independently of program output or a legitimate exit with code 127.
    errors, report = os.pipe2(os.O_CLOEXEC)
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
    use_pty = launch.get('tty', True)
    if use_pty:
        pid, master = pty.fork()
    else:
        child_input, sink = os.pipe()
        stdout, child_output = os.pipe()
        stderr, child_error = os.pipe()
        pid = os.fork()
    if pid == 0:
        os.close(errors)
        try:
            signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM})
            if use_pty:
                fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            else:
                os.setsid()
                for source, target in [(child_input, 0), (child_output, 1), (child_error, 2)]:
                    os.dup2(source, target)
            os.execvpe(argv[0], argv, {**os.environ, **launch['env']})
        except BaseException as exc:
            os.write(report, str(exc).encode(errors='replace')[:2048])
        os._exit(127)
    os.close(report)
    if use_pty:
        sink, streams = master, {master: 1}
    else:
        for fd in (child_input, child_output, child_error):
            os.close(fd)
        streams = {stdout: 1, stderr: 2}
    try:
        signal.signal(signal.SIGTERM, stop)
        signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGTERM})
        with os.fdopen(errors, 'rb') as stream:
            error = stream.read()
        if error:
            status(error=error.decode(errors='replace'), startFailed=True)
            return
        status(started=True, program=argv[0])
        for fd in (0, 1, sink, *streams):
            os.set_blocking(fd, False)
        frames, keys, output = bytearray(), bytearray(), bytearray()
        eof = False
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
            draining = len(output) < 65536
            if draining:
                readers.extend(streams)
            writers = ([1] if output else []) + ([sink] if keys and sink is not None else [])
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
                        if eof:
                            raise ValueError('input after EOF')
                        if sink is not None:
                            keys.extend(data)
                    elif use_pty and kind == 2 and sink is not None:
                        rows, cols = struct.unpack('!HH', data)
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                    elif not use_pty and kind == 3 and size == 0:
                        eof = True
                    elif kind != 2 or not use_pty:
                        raise ValueError('invalid terminal input')
            available = [fd for fd in streams if fd in ready]
            for fd in available:
                try:
                    chunk = os.read(fd, 16384)
                except OSError as exc:
                    if not use_pty or exc.errno != errno.EIO:
                        raise
                    chunk = b''
                if chunk:
                    output.extend(packet(streams[fd], chunk))
                else:
                    del streams[fd]
                    os.close(fd)
                    if fd == sink:
                        sink = None
                        keys.clear()
            if sink in writable:
                try:
                    del keys[:os.write(sink, keys)]
                except BrokenPipeError:
                    os.close(sink)
                    sink = None
                    keys.clear()
            if eof and not keys and sink is not None:
                os.close(sink)
                sink = None
            if 1 in writable:
                del output[:os.write(1, output)]
            if not pid and not output and (not streams or (draining and not available)):
                os.set_blocking(1, True)
                status(exitCode=exit_code)
                return
    finally:
        if pid:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for fd in set(streams) | ({sink} if sink is not None else set()):
            os.close(fd)


run()
