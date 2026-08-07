"""Проверяет, что игрок НЕ получает EVENT о своём же изменении аватара.

Клиент, получив EVENT про самого себя, вызывает AvatarManager.clearAvatars() и
стирает только что залитый аватар — со стороны это выглядит как «кнопка нажалась,
и ничего не произошло». Остальные при этом обязаны узнать об изменении.
"""
import base64, hashlib, hmac, json, os, socket, struct, sys, time, uuid as uuidlib
import urllib.request, urllib.error

SECRET = sys.argv[1].encode()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8080
BASE = f"http://127.0.0.1:{PORT}/api"
SEP = "\x1f"

failures = []

def check(name, cond, detail=""):
    print(f"[{'OK  ' if cond else 'FAIL'}] {name}" + (f"  -- {detail}" if detail else ""))
    if not cond:
        failures.append(name)

def b64(raw): return base64.urlsafe_b64encode(raw).decode().rstrip("=")

def token(u):
    payload = SEP.join([str(u), "T", str(int(time.time()*1000)+600000),
                        "512000", "1", "1000000", "1000000", "64", "1024"])
    raw = payload.encode()
    return b64(raw) + "." + b64(hmac.new(SECRET, raw, hashlib.sha256).digest())

def offline(name):
    d = bytearray(hashlib.md5(("OfflinePlayer:" + name).encode()).digest())
    d[6] = (d[6] & 0x0f) | 0x30
    d[8] = (d[8] & 0x3f) | 0x80
    return uuidlib.UUID(bytes=bytes(d))

def req(method, path, body=None, headers=None):
    r = urllib.request.Request(BASE + path, data=body, method=method)
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

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
        _, self.buf = self.buf.split(b"\r\n\r\n", 1)

    def send_binary(self, data):
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        n = len(data)
        header = b"\x82"
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(header + mask + masked)

    def recv_binary(self, timeout=3):
        try:
            return self._recv(timeout)
        except (socket.timeout, TimeoutError):
            return None

    def _recv(self, timeout):
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


ME = offline("Uploader")
VIEWER = offline("Viewer")

me_ws = Ws("127.0.0.1", PORT, "/ws")
me_ws.send_binary(b"\x00" + token(ME).encode())
check("автор авторизовался по ws", me_ws.recv_binary() == b"\x00")

viewer_ws = Ws("127.0.0.1", PORT, "/ws")
viewer_ws.send_binary(b"\x00" + token(VIEWER).encode())
check("зритель авторизовался по ws", viewer_ws.recv_binary() == b"\x00")

# Оба подписаны на автора: так делает клиент, когда видит игрока рядом.
me_ws.send_binary(b"\x02" + ME.bytes)
viewer_ws.send_binary(b"\x02" + ME.bytes)
time.sleep(0.3)

T = token(ME)
code, _ = req("PUT", "/avatar", os.urandom(50000), {"token": T})
check("загрузка прошла", code == 200, str(code))

body = json.dumps([{"owner": str(ME), "id": "avatar"}]).encode()
code, _ = req("POST", "/equip", body, {"token": T, "Content-Type": "application/json"})
check("equip прошёл", code == 200, str(code))

time.sleep(0.5)

mine = me_ws.recv_binary(timeout=2)
check("автору EVENT НЕ пришёл (иначе он сотрёт свой аватар)", mine is None,
      repr(mine[:20]) if mine else "None")

seen = viewer_ws.recv_binary(timeout=3)
expected = bytes([2]) + ME.bytes
check("зритель EVENT получил", seen == expected,
      repr(seen[:20]) if seen else "None")

me_ws.close()
viewer_ws.close()

print()
if failures:
    print(f"ПРОВАЛЕНО {len(failures)}: " + ", ".join(failures))
    sys.exit(1)
print("EVENT о своём изменении: все проверки пройдены.")
