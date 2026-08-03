"""Minimal raw WebSocket client: verifies the TOKEN -> AUTH handshake and ping relay."""
import base64, hashlib, hmac, os, socket, struct, sys, time, uuid as uuidlib

SECRET = sys.argv[1].encode("utf-8")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8080
SEP = "\x1f"
failures = []

def check(name, cond, detail=""):
    print(f"[{'OK  ' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail else ""))
    if not cond:
        failures.append(name)

def b64(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")

def make_token(player_uuid, name):
    expires = int(time.time() * 1000) + 600_000
    payload = SEP.join([str(player_uuid), name, str(expires), "512000",
                        "1", "1000000", "1000000", "64", "1024"])
    raw = payload.encode("utf-8")
    return b64(raw) + "." + b64(hmac.new(SECRET, raw, hashlib.sha256).digest())

def offline_uuid(name):
    d = bytearray(hashlib.md5(("OfflinePlayer:" + name).encode()).digest())
    d[6] = (d[6] & 0x0f) | 0x30
    d[8] = (d[8] & 0x3f) | 0x80
    return uuidlib.UUID(bytes=bytes(d))

class Ws:
    def __init__(self, host, port, path):
        self.sock = socket.create_connection((host, port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((
            f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("handshake closed")
            self.buf += chunk
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        self.status = head.split(b"\r\n")[0].decode()

    def send_binary(self, data):
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        header = b"\x82"
        n = len(data)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(header + mask + masked)

    def recv_binary(self, timeout=5):
        """Returns the payload, or None on close *or* on timeout (i.e. nothing arrived)."""
        try:
            return self._recv_binary(timeout)
        except (socket.timeout, TimeoutError):
            return None

    def _recv_binary(self, timeout):
        self.sock.settimeout(timeout)
        while True:
            while len(self.buf) < 2:
                chunk = self.sock.recv(4096)
                if not chunk:
                    return None
                self.buf += chunk
            b1, b2 = self.buf[0], self.buf[1]
            length = b2 & 0x7f
            offset = 2
            if length == 126:
                length = struct.unpack(">H", self.buf[2:4])[0]; offset = 4
            elif length == 127:
                length = struct.unpack(">Q", self.buf[2:10])[0]; offset = 10
            while len(self.buf) < offset + length:
                chunk = self.sock.recv(4096)
                if not chunk:
                    return None
                self.buf += chunk
            payload = self.buf[offset:offset + length]
            self.buf = self.buf[offset + length:]
            opcode = b1 & 0x0f
            if opcode == 0x8:
                return None
            if opcode in (0x1, 0x2):
                return payload

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def uuid_bytes(u):
    return u.bytes


VIEWER = offline_uuid("Viewer")
AUTHOR = offline_uuid("TestPlayer")

# 1. bad token must not be accepted
bad = Ws("127.0.0.1", PORT, "/ws")
check("вебсокет отвечает на upgrade", "101" in bad.status, bad.status)
bad.send_binary(b"\x00" + b"not-a-real-token")
check("мусорный токен -> соединение закрыто", bad.recv_binary(timeout=5) is None)
bad.close()

# 2. author and viewer both authenticate
author = Ws("127.0.0.1", PORT, "/ws")
author.send_binary(b"\x00" + make_token(AUTHOR, "TestPlayer").encode())
reply = author.recv_binary()
check("валидный токен -> S2C AUTH (0)", reply == b"\x00", repr(reply))

viewer = Ws("127.0.0.1", PORT, "/ws")
viewer.send_binary(b"\x00" + make_token(VIEWER, "Viewer").encode())
check("второй клиент тоже авторизовался", viewer.recv_binary() == b"\x00")

# 3. viewer subscribes to the author, author pings, viewer receives it
viewer.send_binary(b"\x02" + uuid_bytes(AUTHOR))
time.sleep(0.3)

PING_DATA = b"hello-from-lua"
author.send_binary(b"\x01" + struct.pack(">i", 7) + b"\x01" + PING_DATA)

got = viewer.recv_binary(timeout=5)
relay_ok = (got is not None and got[0] == 1
            and got[1:17] == uuid_bytes(AUTHOR)
            and struct.unpack(">i", got[17:21])[0] == 7
            and got[22:] == PING_DATA)
check("пинг автора долетел до подписчика с верным uuid/id/данными", relay_ok, repr(got[:24]) if got else "None")

# 4. unsubscribe stops the relay
viewer.send_binary(b"\x03" + uuid_bytes(AUTHOR))
time.sleep(0.3)
author.send_binary(b"\x01" + struct.pack(">i", 8) + b"\x01" + b"second")
check("после отписки пинг не приходит", viewer.recv_binary(timeout=2) is None)

# 5. oversized ping is refused with a NOTICE instead of being relayed
viewer.send_binary(b"\x02" + uuid_bytes(AUTHOR))
time.sleep(0.3)
author.send_binary(b"\x01" + struct.pack(">i", 9) + b"\x01" + b"x" * 2000)
notice = author.recv_binary(timeout=3)
check("пинг больше ping-size-limit -> NOTICE автору", notice == b"\x05\x00", repr(notice))

author.close()
viewer.close()

print()
if failures:
    print(f"ПРОВАЛЕНО {len(failures)}: " + ", ".join(failures))
    sys.exit(1)
print("Вебсокет: все проверки пройдены.")
