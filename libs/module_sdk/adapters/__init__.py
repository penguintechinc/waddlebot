"""
WaddleBot Module SDK - Adapters

This package provides adapter classes for integrating external modules
with WaddleBot's module system.
"""

from .base_adapter import BaseAdapter
from .webhook_adapter import WebhookAdapter
from .openwhisk_adapter import OpenWhiskAdapter


__all__ = [
    'BaseAdapter',
    'WebhookAdapter',
    'OpenWhiskAdapter',
]
