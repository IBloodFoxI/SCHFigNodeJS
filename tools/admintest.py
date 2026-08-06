import base64, hashlib, hmac, json, os, sys, time, urllib.request, urllib.error, uuid as uuidlib

PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 8080
BASE = f"http://127.0.0.1:{PORT}/api"
SECRET = sys.argv[1].encode()
ADMIN = sys.argv[2]
DATA = sys.argv[4]
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

ACTIVE = offline("ActivePlayer")
STALE = offline("StalePlayer")

# --- заливаем два аватара ---
for u, size in ((ACTIVE, 100000), (STALE, 90000)):
    t = token(u)
    req("PUT", "/avatar", os.urandom(size), {"token": t})
    req("POST", "/equip", json.dumps([{"owner": str(u), "id": "avatar"}]).encode(),
        {"token": t, "Content-Type": "application/json"})

code, body = req("GET", "/admin/stats", None, {"admin-token": ADMIN})
stats = json.loads(body) if code == 200 else {}
check("admin/stats с верным токеном", code == 200 and stats.get("owners") == 2, f"{code} {body[:60]}")

code, _ = req("GET", "/admin/stats", None, {"admin-token": "wrong"})
check("admin с неверным токеном -> 401", code == 401, str(code))

code, _ = req("GET", "/admin/stats")
check("admin без токена -> 401", code == 401, str(code))

# --- .tmp мусор ---
stale_dir = os.path.join(DATA, "avatars", str(STALE))
with open(os.path.join(stale_dir, "avatar.moon.tmp"), "wb") as f:
    f.write(b"x" * 1234)
check("подложили .tmp файл", os.path.exists(os.path.join(stale_dir, "avatar.moon.tmp")))

# --- состариваем один аватар на 200 дней ---
old = time.time() - 200 * 86400
os.utime(os.path.join(stale_dir, "avatar.moon"), (old, old))

code, body = req("POST", "/admin/sweep", b"", {"admin-token": ADMIN})
result = json.loads(body) if code == 200 else {}
check("admin/sweep отработал", code == 200, f"{code} {body[:80]}")
check("удалён ровно один игрок", result.get("owners") == 1, json.dumps(result))

check("аватар неактивного удалён", not os.path.exists(os.path.join(stale_dir, "avatar.moon")))
check(".tmp подчищен заодно", not os.path.exists(os.path.join(stale_dir, "avatar.moon.tmp")))
check("профиль неактивного удалён",
      not os.path.exists(os.path.join(DATA, "users", f"{STALE}.json")))

active_file = os.path.join(DATA, "avatars", str(ACTIVE), "avatar.moon")
check("аватар активного НЕ тронут", os.path.exists(active_file))

code, body = req("GET", f"/{STALE}", None, {"token": token(STALE)})
check("профиль удалённого пуст", code == 200 and json.loads(body)["equipped"] == [], str(code))

# --- ручное удаление ---
code, body = req("POST", f"/admin/purge/{ACTIVE}", b"", {"admin-token": ADMIN})
purged = json.loads(body) if code == 200 else {}
check("admin/purge удалил аватар", code == 200 and purged.get("removed") == 1,
      f"{code} {body[:60]}")
check("файл активного теперь удалён", not os.path.exists(active_file))

code, body = req("GET", f"/{ACTIVE}/avatar", None, {"token": token(ACTIVE)})
check("после purge отдача -> 404 (кэш хэшей сброшен)", code == 404, str(code))

code, _ = req("POST", "/admin/purge/not-a-uuid", b"", {"admin-token": ADMIN})
check("purge с мусором вместо uuid -> 400", code == 400, str(code))

print()
if failures:
    print(f"ПРОВАЛЕНО {len(failures)}: " + ", ".join(failures))
    sys.exit(1)
print("Администрирование и очистка: все проверки пройдены.")
