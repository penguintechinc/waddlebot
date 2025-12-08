#!/usr/bin/env python3
"""
Import Kong declarative configuration from YAML into Kong Admin API.

This script reads config/kong/kong.yml and imports:
1. Services (POST to /services)
2. Routes (POST to /services/{service}/routes)
3. Consumers (POST to /consumers)
4. Plugins (POST to /plugins, /services/{service}/plugins, or /routes/{route}/plugins)

Usage:
    python3 scripts/import-kong-config.py
    python3 scripts/import-kong-config.py --kong-url http://localhost:8001
    python3 scripts/import-kong-config.py --config-file config/kong/kong.yml
"""

import argparse
import json
import logging
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
import yaml

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)


class KongImporter:
    """Imports Kong declarative configuration from YAML to Kong Admin API."""

    def __init__(self, kong_url: str = "http://localhost:8001", verify_ssl: bool = True):
        """
        Initialize Kong importer.

        Args:
            kong_url: Base URL for Kong Admin API
            verify_ssl: Whether to verify SSL certificates
        """
        self.kong_url = kong_url.rstrip('/')
        self.verify_ssl = verify_ssl
        self.session = requests.Session()
        self.session.headers.update({
            'Content-Type': 'application/json',
            'User-Agent': 'WaddleBot Kong Importer/1.0'
        })

    def _request(self, method: str, endpoint: str, data: Optional[Dict[str, Any]] = None,
                 ignore_conflict: bool = False) -> Optional[Dict[str, Any]]:
        """
        Make HTTP request to Kong Admin API.

        Args:
            method: HTTP method (GET, POST, PUT, DELETE)
            endpoint: API endpoint (e.g., '/services')
            data: Optional request body as dict
            ignore_conflict: If True, ignore 409 Conflict errors

        Returns:
            Response JSON or None on error
        """
        url = f"{self.kong_url}{endpoint}"

        try:
            response = self.session.request(
                method=method,
                url=url,
                json=data,
                verify=self.verify_ssl,
                timeout=10
            )

            # Handle 409 Conflict (resource already exists)
            if response.status_code == 409:
                if ignore_conflict:
                    logger.debug(f"Resource already exists (409): {endpoint}")
                    return response.json() if response.text else None
                else:
                    logger.warning(f"Resource already exists (409): {endpoint}")
                    return None

            response.raise_for_status()
            return response.json() if response.text else None

        except requests.exceptions.ConnectionError as e:
            logger.error(f"Connection error: {e}")
            logger.error(f"Is Kong Admin API running at {self.kong_url}?")
            return None
        except requests.exceptions.Timeout as e:
            logger.error(f"Request timeout: {e}")
            return None
        except requests.exceptions.HTTPError as e:
            logger.error(f"HTTP error {response.status_code}: {response.text}")
            return None
        except Exception as e:
            logger.error(f"Unexpected error: {e}")
            return None

    def check_connection(self) -> bool:
        """Check if Kong Admin API is reachable."""
        try:
            response = self.session.get(
                f"{self.kong_url}/status",
                verify=self.verify_ssl,
                timeout=5
            )
            if response.status_code == 200:
                logger.info(f"Connected to Kong at {self.kong_url}")
                return True
            else:
                logger.error(f"Kong API returned status {response.status_code}")
                return False
        except Exception as e:
            logger.error(f"Cannot connect to Kong: {e}")
            return False

    def import_services(self, services: List[Dict[str, Any]]) -> Dict[str, str]:
        """
        Import services to Kong.

        Args:
            services: List of service configurations

        Returns:
            Mapping of service name to Kong service ID
        """
        if not services:
            logger.info("No services to import")
            return {}

        logger.info(f"Importing {len(services)} service(s)...")
        service_ids = {}

        for service in services:
            name = service.get('name')
            if not name:
                logger.warning("Skipping service without name")
                continue

            # Prepare service payload (remove tags temporarily)
            payload = {k: v for k, v in service.items() if k != 'tags'}

            logger.debug(f"Creating service: {name}")
            result = self._request('POST', '/services', payload, ignore_conflict=True)

            if result:
                service_ids[name] = result.get('id')
                logger.info(f"✓ Service created: {name} (id: {result.get('id')})")
            else:
                logger.warning(f"✗ Failed to create service: {name}")

        return service_ids

    def import_routes(self, routes: List[Dict[str, Any]], service_ids: Dict[str, str]) -> Dict[str, str]:
        """
        Import routes to Kong.

        Args:
            routes: List of route configurations
            service_ids: Mapping of service name to Kong service ID

        Returns:
            Mapping of route name to Kong route ID
        """
        if not routes:
            logger.info("No routes to import")
            return {}

        logger.info(f"Importing {len(routes)} route(s)...")
        route_ids = {}

        for route in routes:
            name = route.get('name')
            service_name = route.get('service')

            if not name or not service_name:
                logger.warning(f"Skipping route without name or service: {route}")
                continue

            service_id = service_ids.get(service_name)
            if not service_id:
                logger.warning(f"Cannot find service ID for {service_name}, skipping route {name}")
                continue

            # Prepare route payload
            payload = {k: v for k, v in route.items() if k not in ('name', 'service', 'tags')}
            payload['service'] = {'id': service_id}

            logger.debug(f"Creating route: {name} for service {service_name}")
            result = self._request(
                'POST',
                f'/services/{service_id}/routes',
                payload,
                ignore_conflict=True
            )

            if result:
                route_ids[name] = result.get('id')
                logger.info(f"✓ Route created: {name} (id: {result.get('id')})")
            else:
                logger.warning(f"✗ Failed to create route: {name}")

        return route_ids

    def import_consumers(self, consumers: List[Dict[str, Any]]) -> Dict[str, str]:
        """
        Import consumers to Kong.

        Args:
            consumers: List of consumer configurations

        Returns:
            Mapping of consumer username to Kong consumer ID
        """
        if not consumers:
            logger.info("No consumers to import")
            return {}

        logger.info(f"Importing {len(consumers)} consumer(s)...")
        consumer_ids = {}

        for consumer in consumers:
            username = consumer.get('username')
            if not username:
                logger.warning("Skipping consumer without username")
                continue

            # Prepare consumer payload
            payload = {k: v for k, v in consumer.items() if k != 'tags'}

            logger.debug(f"Creating consumer: {username}")
            result = self._request('POST', '/consumers', payload, ignore_conflict=True)

            if result:
                consumer_ids[username] = result.get('id')
                logger.info(f"✓ Consumer created: {username} (id: {result.get('id')})")
            else:
                logger.warning(f"✗ Failed to create consumer: {username}")

        return consumer_ids

    def import_plugins(self, plugins: List[Dict[str, Any]], service_ids: Dict[str, str],
                       route_ids: Dict[str, str]) -> int:
        """
        Import plugins to Kong.

        Plugins can be:
        - Global (no service or route)
        - Service-level (service specified)
        - Route-level (route specified)

        Args:
            plugins: List of plugin configurations
            service_ids: Mapping of service name to Kong service ID
            route_ids: Mapping of route name to Kong route ID

        Returns:
            Number of plugins successfully created
        """
        if not plugins:
            logger.info("No plugins to import")
            return 0

        logger.info(f"Importing {len(plugins)} plugin(s)...")
        created = 0

        for plugin in plugins:
            name = plugin.get('name')
            if not name:
                logger.warning("Skipping plugin without name")
                continue

            # Determine plugin scope
            service = plugin.get('service')
            route = plugin.get('route')

            # Prepare plugin payload
            payload = {k: v for k, v in plugin.items() if k not in ('service', 'route', 'tags')}

            # Global plugin
            if not service and not route:
                logger.debug(f"Creating global plugin: {name}")
                endpoint = '/plugins'

                result = self._request('POST', endpoint, payload, ignore_conflict=True)
                if result:
                    logger.info(f"✓ Global plugin created: {name}")
                    created += 1
                else:
                    logger.warning(f"✗ Failed to create global plugin: {name}")

            # Service-level plugin
            elif service and not route:
                service_id = service_ids.get(service)
                if not service_id:
                    logger.warning(f"Cannot find service ID for {service}, skipping plugin {name}")
                    continue

                logger.debug(f"Creating service plugin: {name} for service {service}")
                endpoint = f'/services/{service_id}/plugins'
                payload['service'] = {'id': service_id}

                result = self._request('POST', endpoint, payload, ignore_conflict=True)
                if result:
                    logger.info(f"✓ Service plugin created: {name} for {service}")
                    created += 1
                else:
                    logger.warning(f"✗ Failed to create service plugin: {name}")

            # Route-level plugin
            elif route and not service:
                route_id = route_ids.get(route)
                if not route_id:
                    logger.warning(f"Cannot find route ID for {route}, skipping plugin {name}")
                    continue

                logger.debug(f"Creating route plugin: {name} for route {route}")
                endpoint = f'/routes/{route_id}/plugins'
                payload['route'] = {'id': route_id}

                result = self._request('POST', endpoint, payload, ignore_conflict=True)
                if result:
                    logger.info(f"✓ Route plugin created: {name} for route {route}")
                    created += 1
                else:
                    logger.warning(f"✗ Failed to create route plugin: {name}")

            else:
                logger.warning(f"Plugin has both service and route, skipping: {name}")

        return created

    def import_config(self, config_file: str) -> bool:
        """
        Import Kong configuration from YAML file.

        Args:
            config_file: Path to kong.yml configuration file

        Returns:
            True if import was successful, False otherwise
        """
        config_path = Path(config_file)
        if not config_path.exists():
            logger.error(f"Configuration file not found: {config_file}")
            return False

        # Read YAML configuration
        try:
            with open(config_path, 'r') as f:
                config = yaml.safe_load(f)
        except yaml.YAMLError as e:
            logger.error(f"Failed to parse YAML: {e}")
            return False
        except Exception as e:
            logger.error(f"Failed to read configuration file: {e}")
            return False

        logger.info(f"Loaded Kong configuration from {config_file}")
        logger.info(f"Format version: {config.get('_format_version')}")

        # Import in order
        service_ids = self.import_services(config.get('services', []))
        time.sleep(0.5)  # Brief pause between imports

        route_ids = self.import_routes(config.get('routes', []), service_ids)
        time.sleep(0.5)

        consumer_ids = self.import_consumers(config.get('consumers', []))
        time.sleep(0.5)

        plugin_count = self.import_plugins(
            config.get('plugins', []),
            service_ids,
            route_ids
        )

        # Summary
        logger.info("=" * 60)
        logger.info("IMPORT SUMMARY")
        logger.info("=" * 60)
        logger.info(f"Services: {len(service_ids)}")
        logger.info(f"Routes: {len(route_ids)}")
        logger.info(f"Consumers: {len(consumer_ids)}")
        logger.info(f"Plugins: {plugin_count}")
        logger.info("=" * 60)

        return True


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description='Import Kong declarative configuration from YAML'
    )
    parser.add_argument(
        '--config-file',
        default='config/kong/kong.yml',
        help='Path to Kong YAML configuration (default: config/kong/kong.yml)'
    )
    parser.add_argument(
        '--kong-url',
        default='http://localhost:8001',
        help='Kong Admin API URL (default: http://localhost:8001)'
    )
    parser.add_argument(
        '--no-verify-ssl',
        action='store_true',
        help='Disable SSL certificate verification'
    )
    parser.add_argument(
        '--verbose',
        '-v',
        action='store_true',
        help='Enable debug logging'
    )

    args = parser.parse_args()

    if args.verbose:
        logger.setLevel(logging.DEBUG)

    # Create importer
    importer = KongImporter(
        kong_url=args.kong_url,
        verify_ssl=not args.no_verify_ssl
    )

    # Check connection
    if not importer.check_connection():
        logger.error("Failed to connect to Kong Admin API")
        return 1

    # Import configuration
    if importer.import_config(args.config_file):
        logger.info("Configuration import completed successfully!")
        return 0
    else:
        logger.error("Configuration import failed!")
        return 1


if __name__ == '__main__':
    sys.exit(main())
