"""
Domain Service - Handles custom domain management and DNS verification.
"""
import asyncio
import hashlib
import re
import secrets
from datetime import datetime
from typing import Any, Dict, List, Optional

import dns.resolver

from config import Config


class DomainService:
    """Service for custom domain management."""

    def __init__(self, dal):
        self.dal = dal

    def is_blocked_subdomain(self, subdomain: str) -> bool:
        """Check if subdomain is in blocked list."""
        return subdomain.lower() in Config.BLOCKED_SUBDOMAINS

    def is_valid_subdomain(self, subdomain: str) -> bool:
        """Validate subdomain format."""
        # Alphanumeric and hyphens, 3-63 chars, no leading/trailing hyphens
        pattern = r'^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'
        return bool(re.match(pattern, subdomain.lower()))

    def generate_verification_token(self) -> str:
        """Generate a unique verification token for DNS verification."""
        return secrets.token_hex(32)

    async def get_community_domains(
        self,
        community_id: int
    ) -> List[Dict[str, Any]]:
        """Get all domains for a community."""
        def _query():
            db = self.dal.dal
            rows = db(
                db.community_domains.community_id == community_id
            ).select(orderby=~db.community_domains.is_primary)

            return [
                {
                    'id': r.id,
                    'domain': r.domain,
                    'domain_type': r.domain_type,
                    'is_primary': r.is_primary,
                    'is_verified': r.is_verified,
                    'created_at': r.created_at.isoformat() if r.created_at else None
                }
                for r in rows
            ]

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _query)

    async def get_domain_by_host(self, host: str) -> Optional[Dict[str, Any]]:
        """Look up domain by hostname."""
        def _query():
            db = self.dal.dal
            row = db(db.community_domains.domain == host.lower()).select().first()
            if not row:
                return None
            return {
                'id': row.id,
                'community_id': row.community_id,
                'domain': row.domain,
                'domain_type': row.domain_type,
                'is_primary': row.is_primary,
                'is_verified': row.is_verified
            }

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _query)

    async def create_auto_subdomain(
        self,
        community_id: int,
        community_name: str
    ) -> Optional[str]:
        """Create auto-generated subdomain for community."""
        # Generate slug from community name
        slug = re.sub(r'[^a-z0-9]+', '-', community_name.lower())
        slug = slug.strip('-')[:50]

        # Ensure it's not blocked
        if self.is_blocked_subdomain(slug):
            slug = f"community-{slug}"

        # Check if already taken
        domain = f"{slug}.{Config.BASE_DOMAIN}"

        def _check_exists():
            db = self.dal.dal
            return db(db.community_domains.domain == domain).count() > 0

        loop = asyncio.get_event_loop()
        exists = await loop.run_in_executor(None, _check_exists)

        if exists:
            # Append number to make unique
            counter = 1
            while exists:
                domain = f"{slug}-{counter}.{Config.BASE_DOMAIN}"
                exists = await loop.run_in_executor(None, _check_exists)
                counter += 1
                if counter > 100:
                    return None  # Give up

        # Create the domain entry
        def _create():
            db = self.dal.dal
            db.community_domains.insert(
                community_id=community_id,
                domain=domain,
                domain_type='subdomain',
                is_primary=True,
                is_verified=True,  # Auto-subdomains are auto-verified
                created_at=datetime.utcnow()
            )
            db.commit()
            return domain

        return await loop.run_in_executor(None, _create)

    async def add_custom_subdomain(
        self,
        community_id: int,
        subdomain: str
    ) -> Dict[str, Any]:
        """Add a custom subdomain for community."""
        subdomain = subdomain.lower()

        # Validate format
        if not self.is_valid_subdomain(subdomain):
            return {'success': False, 'error': 'Invalid subdomain format'}

        # Check if blocked
        if self.is_blocked_subdomain(subdomain):
            return {'success': False, 'error': 'This subdomain is reserved'}

        domain = f"{subdomain}.{Config.BASE_DOMAIN}"

        def _create():
            db = self.dal.dal

            # Check if already exists
            existing = db(db.community_domains.domain == domain).select().first()
            if existing:
                if existing.community_id == community_id:
                    return {'success': False, 'error': 'You already have this subdomain'}
                return {'success': False, 'error': 'Subdomain is already taken'}

            # Create new entry
            db.community_domains.insert(
                community_id=community_id,
                domain=domain,
                domain_type='subdomain',
                is_primary=False,
                is_verified=True,  # Subdomains are auto-verified
                created_at=datetime.utcnow()
            )
            db.commit()
            return {'success': True, 'domain': domain}

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _create)

    async def add_custom_domain(
        self,
        community_id: int,
        domain: str
    ) -> Dict[str, Any]:
        """Add a custom domain (requires DNS verification)."""
        domain = domain.lower()

        # Basic validation
        if not re.match(r'^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$', domain):
            return {'success': False, 'error': 'Invalid domain format'}

        # Cannot be a waddlebot.io subdomain
        if domain.endswith(f'.{Config.BASE_DOMAIN}'):
            return {
                'success': False,
                'error': f'Use custom subdomain option for {Config.BASE_DOMAIN} subdomains'
            }

        verification_token = self.generate_verification_token()

        def _create():
            db = self.dal.dal

            # Check if already exists
            existing = db(db.community_domains.domain == domain).select().first()
            if existing:
                return {'success': False, 'error': 'Domain is already registered'}

            # Create new entry requiring verification
            db.community_domains.insert(
                community_id=community_id,
                domain=domain,
                domain_type='custom',
                is_primary=False,
                is_verified=False,
                verification_token=verification_token,
                created_at=datetime.utcnow()
            )
            db.commit()
            return {
                'success': True,
                'domain': domain,
                'verification_token': verification_token,
                'verification_record': f'_waddlebot-verify.{domain}',
                'verification_value': verification_token
            }

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _create)

    async def verify_custom_domain(
        self,
        community_id: int,
        domain: str
    ) -> Dict[str, Any]:
        """Verify DNS TXT record for custom domain."""
        def _get_domain_info():
            db = self.dal.dal
            return db(
                (db.community_domains.community_id == community_id) &
                (db.community_domains.domain == domain) &
                (db.community_domains.domain_type == 'custom')
            ).select().first()

        loop = asyncio.get_event_loop()
        domain_info = await loop.run_in_executor(None, _get_domain_info)

        if not domain_info:
            return {'success': False, 'error': 'Domain not found'}

        if domain_info.is_verified:
            return {'success': True, 'message': 'Domain already verified'}

        # Check DNS TXT record
        verification_record = f'_waddlebot-verify.{domain}'
        expected_value = domain_info.verification_token

        try:
            answers = dns.resolver.resolve(verification_record, 'TXT')
            verified = False
            for rdata in answers:
                txt_value = str(rdata).strip('"')
                if txt_value == expected_value:
                    verified = True
                    break

            if not verified:
                return {
                    'success': False,
                    'error': 'DNS TXT record not found or incorrect',
                    'expected_record': verification_record,
                    'expected_value': expected_value
                }

            # Update verification status
            def _update():
                db = self.dal.dal
                db(db.community_domains.id == domain_info.id).update(
                    is_verified=True,
                    updated_at=datetime.utcnow()
                )
                db.commit()

            await loop.run_in_executor(None, _update)
            return {'success': True, 'message': 'Domain verified successfully'}

        except dns.resolver.NXDOMAIN:
            return {
                'success': False,
                'error': 'DNS TXT record not found',
                'expected_record': verification_record,
                'expected_value': expected_value
            }
        except Exception as e:
            return {'success': False, 'error': f'DNS lookup failed: {str(e)}'}

    async def set_primary_domain(
        self,
        community_id: int,
        domain_id: int
    ) -> Dict[str, Any]:
        """Set a domain as primary for community."""
        def _update():
            db = self.dal.dal

            # Verify domain belongs to community and is verified
            target = db(
                (db.community_domains.id == domain_id) &
                (db.community_domains.community_id == community_id) &
                (db.community_domains.is_verified == True)  # noqa: E712
            ).select().first()

            if not target:
                return {'success': False, 'error': 'Domain not found or not verified'}

            # Remove primary from all other domains
            db(db.community_domains.community_id == community_id).update(
                is_primary=False,
                updated_at=datetime.utcnow()
            )

            # Set new primary
            db(db.community_domains.id == domain_id).update(
                is_primary=True,
                updated_at=datetime.utcnow()
            )
            db.commit()
            return {'success': True}

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _update)

    async def delete_domain(
        self,
        community_id: int,
        domain_id: int
    ) -> Dict[str, Any]:
        """Delete a domain from community."""
        def _delete():
            db = self.dal.dal

            # Verify domain belongs to community
            target = db(
                (db.community_domains.id == domain_id) &
                (db.community_domains.community_id == community_id)
            ).select().first()

            if not target:
                return {'success': False, 'error': 'Domain not found'}

            if target.is_primary:
                return {'success': False, 'error': 'Cannot delete primary domain'}

            db(db.community_domains.id == domain_id).delete()
            db.commit()
            return {'success': True}

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _delete)
