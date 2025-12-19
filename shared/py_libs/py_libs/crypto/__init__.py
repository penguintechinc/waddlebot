"""
Crypto module - Cryptographic utilities.

Provides:
- tokens: Secure token generation
- passwords: Password hashing using Argon2id
- encryption: AES-256-GCM authenticated encryption
"""

from .encryption import (
    AUTH_TAG_LENGTH,
    IV_LENGTH,
    KEY_LENGTH,
    DecryptionError,
    EncryptionError,
    decrypt,
    decrypt_bytes,
    encrypt,
    generate_key,
    generate_key_hex,
    key_from_hex,
)
from .passwords import (
    HashingError,
    HashingOptions,
    InvalidHashError,
    VerificationError,
    VerifyMismatchError,
    hash_password,
    needs_rehash,
    verify_password,
)
from .tokens import (
    generate_api_key,
    generate_numeric_code,
    generate_session_id,
    generate_token,
    generate_url_safe_token,
)

__all__ = [
    # Tokens
    "generate_token",
    "generate_url_safe_token",
    "generate_api_key",
    "generate_numeric_code",
    "generate_session_id",
    # Passwords
    "HashingOptions",
    "hash_password",
    "verify_password",
    "needs_rehash",
    "HashingError",
    "InvalidHashError",
    "VerificationError",
    "VerifyMismatchError",
    # Encryption
    "IV_LENGTH",
    "AUTH_TAG_LENGTH",
    "KEY_LENGTH",
    "EncryptionError",
    "DecryptionError",
    "generate_key",
    "generate_key_hex",
    "key_from_hex",
    "encrypt",
    "decrypt",
    "decrypt_bytes",
]
