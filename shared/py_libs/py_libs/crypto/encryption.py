"""
AES-256-GCM encryption utilities.

Provides authenticated encryption using AES-256 in GCM mode, which offers:
- Confidentiality: Data is encrypted and unreadable without the key
- Integrity: Any tampering with ciphertext is detected
- Authentication: Verifies data came from a holder of the key

The encryption format is: IV (12 bytes) + Auth Tag (16 bytes) + Ciphertext
All encoded as base64 for safe storage/transmission.
"""

import base64
import os
from typing import Union

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Constants
IV_LENGTH = 12  # 96-bit IV for GCM (NIST recommended)
AUTH_TAG_LENGTH = 16  # 128-bit authentication tag
KEY_LENGTH = 32  # 256-bit key for AES-256


class EncryptionError(Exception):
    """Raised when encryption fails."""
    pass


class DecryptionError(Exception):
    """Raised when decryption fails."""
    pass


def _validate_key(key: bytes) -> None:
    """Validate that the key is exactly 32 bytes."""
    if len(key) != KEY_LENGTH:
        raise ValueError(
            f"Key must be exactly {KEY_LENGTH} bytes for AES-256, got {len(key)} bytes"
        )


def generate_key() -> bytes:
    """
    Generate a new random 256-bit encryption key.

    Returns:
        32-byte random key suitable for AES-256.

    Example:
        >>> key = generate_key()
        >>> len(key)
        32
    """
    return os.urandom(KEY_LENGTH)


def generate_key_hex() -> str:
    """
    Generate a new random 256-bit encryption key as hex string.

    Returns:
        64-character hex string representing a 32-byte key.

    Example:
        >>> key_hex = generate_key_hex()
        >>> len(key_hex)
        64
    """
    return generate_key().hex()


def key_from_hex(hex_key: str) -> bytes:
    """
    Convert a hex-encoded key string to bytes.

    Args:
        hex_key: 64-character hex string.

    Returns:
        32-byte key.

    Raises:
        ValueError: If the hex string is invalid or wrong length.
    """
    try:
        key = bytes.fromhex(hex_key)
    except ValueError as e:
        raise ValueError(f"Invalid hex key: {e}") from e

    _validate_key(key)
    return key


def encrypt(plaintext: Union[str, bytes], key: bytes) -> str:
    """
    Encrypt plaintext using AES-256-GCM.

    Args:
        plaintext: The data to encrypt (string or bytes).
        key: 32-byte encryption key.

    Returns:
        Base64-encoded ciphertext (includes IV and auth tag).

    Raises:
        ValueError: If key is wrong size or plaintext is empty.
        EncryptionError: If encryption fails.

    Example:
        >>> key = generate_key()
        >>> encrypted = encrypt("Hello, World!", key)
        >>> isinstance(encrypted, str)
        True
    """
    _validate_key(key)

    if not plaintext:
        raise ValueError("Plaintext cannot be empty")

    # Convert string to bytes if necessary
    if isinstance(plaintext, str):
        plaintext_bytes = plaintext.encode("utf-8")
    else:
        plaintext_bytes = plaintext

    try:
        # Generate random IV
        iv = os.urandom(IV_LENGTH)

        # Create cipher and encrypt
        aesgcm = AESGCM(key)
        ciphertext = aesgcm.encrypt(iv, plaintext_bytes, None)

        # GCM appends auth tag to ciphertext, extract it
        # ciphertext = encrypted_data + auth_tag (16 bytes)
        auth_tag = ciphertext[-AUTH_TAG_LENGTH:]
        encrypted_data = ciphertext[:-AUTH_TAG_LENGTH]

        # Combine: IV + Auth Tag + Ciphertext
        combined = iv + auth_tag + encrypted_data

        return base64.b64encode(combined).decode("ascii")

    except Exception as e:
        raise EncryptionError(f"Encryption failed: {e}") from e


def decrypt(ciphertext: str, key: bytes) -> str:
    """
    Decrypt base64-encoded ciphertext using AES-256-GCM.

    Args:
        ciphertext: Base64-encoded string (as produced by encrypt).
        key: 32-byte encryption key.

    Returns:
        Decrypted plaintext as string.

    Raises:
        ValueError: If key is wrong size or ciphertext is empty/malformed.
        DecryptionError: If decryption fails (wrong key or tampered data).

    Example:
        >>> key = generate_key()
        >>> encrypted = encrypt("Hello, World!", key)
        >>> decrypt(encrypted, key)
        'Hello, World!'
    """
    _validate_key(key)

    if not ciphertext:
        raise ValueError("Ciphertext cannot be empty")

    try:
        # Decode base64
        data = base64.b64decode(ciphertext)
    except Exception as e:
        raise ValueError(f"Invalid base64 ciphertext: {e}") from e

    min_length = IV_LENGTH + AUTH_TAG_LENGTH
    if len(data) < min_length:
        raise ValueError(
            f"Ciphertext too short: expected at least {min_length} bytes, got {len(data)}"
        )

    try:
        # Extract components: IV + Auth Tag + Ciphertext
        iv = data[:IV_LENGTH]
        auth_tag = data[IV_LENGTH:IV_LENGTH + AUTH_TAG_LENGTH]
        encrypted_data = data[IV_LENGTH + AUTH_TAG_LENGTH:]

        # Reconstruct ciphertext with auth tag appended (as GCM expects)
        ciphertext_with_tag = encrypted_data + auth_tag

        # Create cipher and decrypt
        aesgcm = AESGCM(key)
        plaintext_bytes = aesgcm.decrypt(iv, ciphertext_with_tag, None)

        return plaintext_bytes.decode("utf-8")

    except Exception as e:
        raise DecryptionError(f"Decryption failed: {e}") from e


def decrypt_bytes(ciphertext: str, key: bytes) -> bytes:
    """
    Decrypt base64-encoded ciphertext to bytes.

    Same as decrypt() but returns raw bytes instead of string.
    Useful for binary data.

    Args:
        ciphertext: Base64-encoded string (as produced by encrypt).
        key: 32-byte encryption key.

    Returns:
        Decrypted plaintext as bytes.
    """
    _validate_key(key)

    if not ciphertext:
        raise ValueError("Ciphertext cannot be empty")

    try:
        data = base64.b64decode(ciphertext)
    except Exception as e:
        raise ValueError(f"Invalid base64 ciphertext: {e}") from e

    min_length = IV_LENGTH + AUTH_TAG_LENGTH
    if len(data) < min_length:
        raise ValueError(
            f"Ciphertext too short: expected at least {min_length} bytes, got {len(data)}"
        )

    try:
        iv = data[:IV_LENGTH]
        auth_tag = data[IV_LENGTH:IV_LENGTH + AUTH_TAG_LENGTH]
        encrypted_data = data[IV_LENGTH + AUTH_TAG_LENGTH:]

        ciphertext_with_tag = encrypted_data + auth_tag

        aesgcm = AESGCM(key)
        return aesgcm.decrypt(iv, ciphertext_with_tag, None)

    except Exception as e:
        raise DecryptionError(f"Decryption failed: {e}") from e


__all__ = [
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
