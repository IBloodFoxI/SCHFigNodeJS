"""Воспроизводит сценарий, из-за которого аватар «пропадает» после загрузки.

Клиент шлёт в /equip тот owner, который он считает своим локальным UUID. Он может
не совпадать с UUID, который выдал игровой сервер, — заметнее всего у офлайн-игроков.
Загрузка при этом уходит под UUID из токена, и без обработки этого случая профиль
оставался пустым: аватар загрузился, но никто его не носит.
"""
import base64, hashlib, hmac, json, os, sys, time, urllib.request, urllib.error, uuid as uuidlib

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

# UUID, который выдал сервер (offline, v3) — он же в токене.
SERVER_UUID = offline("CrackedPlayer")
# UUID, который клиент считает своим (лаунчерный, v4) — попадёт в /equip.
CLIENT_UUID = uuidlib.UUID("11111111-2222-4333-8444-555555555555")

check("UUID сервера и клиента различаются", str(SERVER_UUID) != str(CLIENT_UUID),
      f"{SERVER_UUID} vs {CLIENT_UUID}")

T = token(SERVER_UUID)
AVATAR = os.urandom(80000)

code, _ = req("PUT", "/avatar", AVATAR, {"token": T})
check("загрузка проходит", code == 200, str(code))

# Ровно то, что шлёт клиент: owner из своего представления о себе.
body = json.dumps([{"owner": str(CLIENT_UUID), "id": "avatar"}]).encode()
code, _ = req("POST", "/equip", body, {"token": T, "Content-Type": "application/json"})
check("equip с чужим owner принят", code == 200, str(code))

code, data = req("GET", f"/{SERVER_UUID}", None, {"token": T})
profile = json.loads(data) if code == 200 else {}
equipped = profile.get("equipped", [])

check("профиль НЕ пустой (иначе аватар «пропадает»)", len(equipped) == 1,
      json.dumps(equipped))
check("аватар записан на серверный UUID",
      len(equipped) == 1 and equipped[0]["owner"] == str(SERVER_UUID),
      equipped[0]["owner"] if equipped else "-")
check("хэш совпадает с загруженным",
      len(equipped) == 1 and equipped[0]["hash"] == hashlib.sha256(AVATAR).hexdigest())

code, served = req("GET", f"/{SERVER_UUID}/avatar", None, {"token": T})
check("аватар отдаётся байт в байт", code == 200 and served == AVATAR,
      f"{code} {len(served) if served else 0}b")

# Подмена работает только в окне сразу после своей загрузки. Игрок, который ничего
# не загружал, просит несуществующий аватар — и получает пустой профиль, а не чужой.
OTHER = offline("SomebodyElse")
T2 = token(OTHER)
body = json.dumps([{"owner": str(SERVER_UUID), "id": "nosuchavatar"}]).encode()
req("POST", "/equip", body, {"token": T2, "Content-Type": "application/json"})
code, data = req("GET", f"/{OTHER}", None, {"token": T2})
check("без своей загрузки несуществующий аватар отбрасывается",
      json.loads(data)["equipped"] == [], json.dumps(json.loads(data)["equipped"]))

print()
if failures:
    print(f"ПРОВАЛЕНО {len(failures)}: " + ", ".join(failures))
    sys.exit(1)
print("Сценарий с расхождением UUID: все проверки пройдены.")
