"""
Password hashing utilities using Argon2id.

Argon2id is the recommended algorithm for password hashing as it provides:
- Memory-hardness (resistant to GPU attacks)
- Time-hardness (resistant to brute force)
- Side-channel resistance (hybrid of Argon2i and Argon2d)

This module provides async-friendly password hashing suitable for
high-performance web applications.
"""

from dataclasses import dataclass
from typing import Optional

import argon2
from argon2 import PasswordHasher, Type
from argon2.exceptions import (
    HashingError,
    InvalidHashError,
    VerificationError,
    VerifyMismatchError,
)


@dataclass(frozen=True, slots=True)
class HashingOptions:
    """
    Configuration options for Argon2 password hashing.

    Attributes:
        time_cost: Number of iterations (higher = slower, more secure).
        memory_cost: Memory usage in KiB (higher = more memory-hard).
        parallelism: Number of parallel threads.
        hash_len: Length of the hash output in bytes.
        salt_len: Length of the random salt in bytes.
    """
    time_cost: int = 3
    memory_cost: int = 65536  # 64 MB
    parallelism: int = 4
    hash_len: int = 32
    salt_len: int = 16

    @classmethod
    def default(cls) -> "HashingOptions":
        """Default options - balanced security and performance."""
        return cls()

    @classmethod
    def high_security(cls) -> "HashingOptions":
        """High security options - for sensitive applications."""
        return cls(
            time_cost=4,
            memory_cost=131072,  # 128 MB
            parallelism=4,
            hash_len=32,
            salt_len=32,
        )

    @classmethod
    def low_memory(cls) -> "HashingOptions":
        """Low memory options - for constrained environments."""
        return cls(
            time_cost=6,
            memory_cost=16384,  # 16 MB
            parallelism=2,
            hash_len=32,
            salt_len=16,
        )


# Default password hasher instance
_default_hasher: Optional[PasswordHasher] = None


def _get_hasher(options: Optional[HashingOptions] = None) -> PasswordHasher:
    """Get a PasswordHasher instance with the specified options."""
    global _default_hasher

    if options is None:
        if _default_hasher is None:
            opts = HashingOptions.default()
            _default_hasher = PasswordHasher(
                time_cost=opts.time_cost,
                memory_cost=opts.memory_cost,
                parallelism=opts.parallelism,
                hash_len=opts.hash_len,
                salt_len=opts.salt_len,
                type=Type.ID,  # Argon2id
            )
        return _default_hasher

    return PasswordHasher(
        time_cost=options.time_cost,
        memory_cost=options.memory_cost,
        parallelism=options.parallelism,
        hash_len=options.hash_len,
        salt_len=options.salt_len,
        type=Type.ID,
    )


def hash_password(password: str, options: Optional[HashingOptions] = None) -> str:
    """
    Hash a password using Argon2id.

    Args:
        password: The plaintext password to hash.
        options: Optional hashing configuration. Uses defaults if not provided.

    Returns:
        The Argon2 encoded hash string (includes algorithm params and salt).

    Raises:
        ValueError: If password is empty.
        HashingError: If hashing fails for any reason.

    Example:
        >>> hashed = hash_password("mysecretpassword")
        >>> hashed.startswith("$argon2id$")
        True
    """
    if not password:
        raise ValueError("Password cannot be empty")

    hasher = _get_hasher(options)
    try:
        return hasher.hash(password)
    except HashingError as e:
        raise HashingError(f"Failed to hash password: {e}") from e


def verify_password(password: str, hash: str) -> bool:
    """
    Verify a password against an Argon2 hash.

    Args:
        password: The plaintext password to verify.
        hash: The Argon2 encoded hash string.

    Returns:
        True if the password matches, False otherwise.

    Raises:
        ValueError: If password or hash is empty.
        InvalidHashError: If the hash format is invalid.

    Example:
        >>> hashed = hash_password("mysecretpassword")
        >>> verify_password("mysecretpassword", hashed)
        True
        >>> verify_password("wrongpassword", hashed)
        False
    """
    if not password:
        raise ValueError("Password cannot be empty")
    if not hash:
        raise ValueError("Hash cannot be empty")

    hasher = _get_hasher()
    try:
        hasher.verify(hash, password)
        return True
    except VerifyMismatchError:
        return False
    except InvalidHashError as e:
        raise InvalidHashError(f"Invalid hash format: {e}") from e


def needs_rehash(hash: str, options: Optional[HashingOptions] = None) -> bool:
    """
    Check if a password hash needs to be rehashed.

    This is useful when hashing parameters have been updated and
    existing hashes should be upgraded on next login.

    Args:
        hash: The Argon2 encoded hash string.
        options: The current hashing configuration to check against.

    Returns:
        True if the hash should be rehashed with current parameters.

    Example:
        >>> hashed = hash_password("password", HashingOptions.low_memory())
        >>> needs_rehash(hashed, HashingOptions.default())
        True
    """
    if not hash:
        return True

    hasher = _get_hasher(options)
    try:
        return hasher.check_needs_rehash(hash)
    except InvalidHashError:
        return True


__all__ = [
    "HashingOptions",
    "hash_password",
    "verify_password",
    "needs_rehash",
    # Re-export argon2 exceptions for convenience
    "HashingError",
    "InvalidHashError",
    "VerificationError",
    "VerifyMismatchError",
]
