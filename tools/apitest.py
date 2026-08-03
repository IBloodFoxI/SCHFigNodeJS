import base64, hashlib, hmac, json, os, sys, time, urllib.request, urllib.error, uuid as uuidlib

PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8080
BASE = f"http://127.0.0.1:{PORT}/api"
SECRET = sys.argv[1].encode("utf-8")
SEP = "\x1f"

failures = []

def check(name, cond, detail=""):
    status = "OK  " if cond else "FAIL"
    print(f"[{status}] {name}" + (f"  -- {detail}" if detail else ""))
    if not cond:
        failures.append(name)

def b64(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")

def make_token(player_uuid, name, max_size=512000, ttl=600):
    expires = int(time.time() * 1000) + ttl * 1000
    payload = SEP.join([str(player_uuid), name, str(expires), str(max_size),
                        "1", "1000000", "1000000", "64", "1024"])
    raw = payload.encode("utf-8")
    sig = hmac.new(SECRET, raw, hashlib.sha256).digest()
    return b64(raw) + "." + b64(sig)

def request(method, path, body=None, token=None, ctype=None):
    req = urllib.request.Request(BASE + path, data=body, method=method)
    if token:
        req.add_header("token", token)
    if ctype:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

# Offline-mode UUID, exactly what Velocity/nLogin hand a cracked player: name-based v3.
def offline_uuid(name):
    digest = bytearray(hashlib.md5(("OfflinePlayer:" + name).encode("utf-8")).digest())
    digest[6] = (digest[6] & 0x0f) | 0x30
    digest[8] = (digest[8] & 0x3f) | 0x80
    return uuidlib.UUID(bytes=bytes(digest))

PLAYER = offline_uuid("TestPlayer")
print(f"offline uuid = {PLAYER} (version {PLAYER.version})")
check("тестовый UUID действительно v3 (как у пиратки)", PLAYER.version == 3)

TOKEN = make_token(PLAYER, "TestPlayer")

# --- unauthenticated ---
code, body = request("GET", "/version")
check("GET /version без токена -> 200", code == 200, f"{code} {body[:60]}")

code, body = request("GET", "/limits")
check("GET /limits без токена -> 401", code == 401, str(code))

code, body = request("GET", "/limits", token="garbage.garbage")
check("подделанный токен -> 401", code == 401, str(code))

code, body = request("GET", "/auth/id?username=TestPlayer")
check("GET /auth/id -> serverId", code == 200 and len(body) > 8, f"{code} {body[:24]}")

# --- limits: the whole point of the plugin ---
code, body = request("GET", "/limits", token=TOKEN)
limits_ok = False
if code == 200:
    data = json.loads(body)
    limits_ok = data["limits"]["maxAvatarSize"] == 512000
    detail = json.dumps(data["limits"])
else:
    detail = str(code)
check("GET /limits отдаёт maxAvatarSize=512000 (не 102400)", limits_ok, detail)

# --- profile of a v3 player ---
code, body = request("GET", f"/{PLAYER}", token=TOKEN)
profile_ok = code == 200 and json.loads(body)["equipped"] == []
check("GET /<offline-uuid> -> пустой профиль", profile_ok, str(code))

# --- upload ---
AVATAR = os.urandom(150000)   # 150 КБ: больше официальных 100 КБ, меньше нашего лимита
code, body = request("PUT", "/avatar", body=AVATAR, token=TOKEN,
                     ctype="application/octet-stream")
check("PUT аватара на 150 КБ -> 200 (официальный бэкенд отказал бы)", code == 200, str(code))

TOO_BIG = b"x" * 600000
code, body = request("PUT", "/avatar", body=TOO_BIG, token=TOKEN,
                     ctype="application/octet-stream")
check("PUT на 600 КБ -> отказ (выше max-avatar-size)", code >= 400, str(code))

# --- equip ---
equip_body = json.dumps([{"owner": str(PLAYER), "id": "avatar"}]).encode()
code, body = request("POST", "/equip", body=equip_body, token=TOKEN, ctype="application/json")
check("POST /equip -> 200", code == 200, str(code))

code, body = request("GET", f"/{PLAYER}", token=TOKEN)
equipped_ok = False
expected_hash = hashlib.sha256(AVATAR).hexdigest()
if code == 200:
    data = json.loads(body)
    entries = data["equipped"]
    equipped_ok = (len(entries) == 1 and entries[0]["owner"] == str(PLAYER)
                   and entries[0]["id"] == "avatar" and entries[0]["hash"] == expected_hash)
    detail = json.dumps(entries)
else:
    detail = str(code)
check("профиль отдаёт надетый аватар с верным sha256", equipped_ok, detail)

badges_ok = code == 200 and "pride" in json.loads(body)["equippedBadges"]
check("в профиле есть equippedBadges (иначе клиент падает)", badges_ok)

# --- download ---
code, body = request("GET", f"/{PLAYER}/avatar", token=TOKEN)
check("GET аватара возвращает те же байты", code == 200 and body == AVATAR,
      f"{code} {len(body) if body else 0}b")

# --- delete ---
code, body = request("DELETE", "/avatar", token=TOKEN)
check("DELETE аватара -> 200", code == 200, str(code))

code, body = request("GET", f"/{PLAYER}/avatar", token=TOKEN)
check("после удаления -> 404", code == 404, str(code))

code, body = request("GET", f"/{PLAYER}", token=TOKEN)
check("после удаления профиль пуст", code == 200 and json.loads(body)["equipped"] == [])

print()
if failures:
    print(f"ПРОВАЛЕНО {len(failures)}: " + ", ".join(failures))
    sys.exit(1)
print("Все проверки пройдены.")
