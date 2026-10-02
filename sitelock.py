"""Shared password for the grader website, without any database.

The password comes from $GRADER_PASSWORD or the git-ignored file .grader_password.
- server.py checks it on every data/submit request.
- The static GitHub Pages build encrypts leaderboard.json with it (PBKDF2 + AES-GCM),
  and the page decrypts in the browser with WebCrypto after the user logs in.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
from typing import Any

APP_DIR = Path(__file__).resolve().parent
PASSWORD_FILE = APP_DIR / ".grader_password"
PBKDF2_ITERATIONS = 200_000
# No 0/o/1/l/i so the password is easy to read out and type.
_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


def generate_password() -> str:
    groups = ["".join(secrets.choice(_ALPHABET) for _ in range(4)) for _ in range(3)]
    return "oai-" + "-".join(groups)


def load_password(create: bool = False) -> str | None:
    """Password from env or file; with ``create`` a new one is generated and saved."""
    env = os.environ.get("GRADER_PASSWORD", "").strip()
    if env:
        return env
    if PASSWORD_FILE.is_file():
        stored = PASSWORD_FILE.read_text(encoding="utf-8").strip()
        if stored:
            return stored
    if not create:
        return None
    password = generate_password()
    PASSWORD_FILE.write_text(password + "\n", encoding="utf-8")
    PASSWORD_FILE.chmod(0o600)
    return password


def check_password(supplied: str | None, expected: str) -> bool:
    return hmac.compare_digest((supplied or "").encode("utf-8"), expected.encode("utf-8"))


def encrypt_json(payload: Any, password: str) -> dict[str, Any]:
    """Encrypt a JSON payload into an envelope the page can decrypt with WebCrypto."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS, dklen=32)
    plaintext = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    ciphertext = AESGCM(key).encrypt(iv, plaintext, None)  # ciphertext || 16-byte tag, as WebCrypto expects
    b64 = lambda b: base64.b64encode(b).decode("ascii")  # noqa: E731
    return {
        "encrypted": True,
        "kdf": "PBKDF2-SHA256",
        "iterations": PBKDF2_ITERATIONS,
        "salt": b64(salt),
        "iv": b64(iv),
        "data": b64(ciphertext),
    }


def decrypt_json(envelope: dict[str, Any], password: str) -> Any:
    """Inverse of encrypt_json (used by tests)."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    raw = lambda k: base64.b64decode(envelope[k])  # noqa: E731
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), raw("salt"), envelope["iterations"], dklen=32)
    return json.loads(AESGCM(key).decrypt(raw("iv"), raw("data"), None))
