"""
Async PyDAL Database Wrapper
=============================

Provides async wrapper around PyDAL for non-blocking database operations.
Supports connection pooling, read replicas, and transaction management.
"""

from pydal import DAL, Field
import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Optional, Any, List, Dict
from contextlib import asynccontextmanager
import logging

logger = logging.getLogger(__name__)


class AsyncDAL:
    """
    Async wrapper for PyDAL database operations.

    Uses ThreadPoolExecutor to run blocking PyDAL operations
    in a thread pool, allowing async/await syntax without blocking
    the event loop.
    """

    def __init__(
        self,
        uri: str,
        pool_size: int = 10,
        folder: Optional[str] = None,
        migrate: bool = True,
        fake_migrate: bool = False,
        read_replica_uri: Optional[str] = None
    ):
        """
        Initialize AsyncDAL with connection details.

        Args:
            uri: Database connection string (primary/write)
            pool_size: Connection pool size
            folder: Folder for database files
            migrate: Enable automatic migrations
            fake_migrate: Enable fake migrations
            read_replica_uri: Optional read replica connection string
        """
        self.uri = uri
        self.pool_size = pool_size
        self.folder = folder
        self.migrate = migrate
        self.fake_migrate = fake_migrate
        self.read_replica_uri = read_replica_uri

        # Primary DAL (write operations)
        self.dal = DAL(
            uri,
            pool_size=pool_size,
            folder=folder,
            migrate=migrate,
            fake_migrate=fake_migrate,
            lazy_tables=True
        )

        # Read replica DAL (read operations)
        self.read_dal = None
        if read_replica_uri:
            self.read_dal = DAL(
                read_replica_uri,
                pool_size=pool_size,
                folder=folder,
                migrate=False,  # Never migrate on read replica
                fake_migrate=False,
                lazy_tables=True
            )

        # Thread pool for async operations
        self.executor = ThreadPoolExecutor(
            max_workers=pool_size,
            thread_name_prefix="async_dal_"
        )

        logger.info(f"AsyncDAL initialized with pool_size={pool_size}")
        if read_replica_uri:
            logger.info("Read replica configured for query distribution")

    def define_table(self, *args, **kwargs):
        """Define table on primary DAL (for migrations)"""
        table = self.dal.define_table(*args, **kwargs)

        # Also define on read replica if exists
        if self.read_dal:
            self.read_dal.define_table(*args, **kwargs)

        return table

    async def select_async(self, query, *args, **kwargs):
        """
        Async select operation using read replica if available.

        Args:
            query: PyDAL query object
            *args, **kwargs: Additional select arguments

        Returns:
            Rows object with query results
        """
        loop = asyncio.get_event_loop()
        dal = self.read_dal if self.read_dal else self.dal

        def _select():
            try:
                return query.select(*args, **kwargs)
            except Exception as e:
                logger.error(f"Select error: {e}")
                raise

        return await loop.run_in_executor(self.executor, _select)

    async def insert_async(self, table, **fields):
        """
        Async insert operation on primary DAL.

        Args:
            table: PyDAL table object
            **fields: Field values to insert

        Returns:
            Inserted record ID
        """
        loop = asyncio.get_event_loop()

        def _insert():
            try:
                return table.insert(**fields)
            except Exception as e:
                logger.error(f"Insert error: {e}")
                raise

        return await loop.run_in_executor(self.executor, _insert)

    async def update_async(self, query, **update_fields):
        """
        Async update operation on primary DAL.

        Args:
            query: PyDAL query object
            **update_fields: Fields to update

        Returns:
            Number of records updated
        """
        loop = asyncio.get_event_loop()

        def _update():
            try:
                return self.dal(query).update(**update_fields)
            except Exception as e:
                logger.error(f"Update error: {e}")
                raise

        return await loop.run_in_executor(self.executor, _update)

    async def delete_async(self, query):
        """
        Async delete operation on primary DAL.

        Args:
            query: PyDAL query object

        Returns:
            Number of records deleted
        """
        loop = asyncio.get_event_loop()

        def _delete():
            try:
                return self.dal(query).delete()
            except Exception as e:
                logger.error(f"Delete error: {e}")
                raise

        return await loop.run_in_executor(self.executor, _delete)

    async def count_async(self, query):
        """
        Async count operation using read replica if available.

        Args:
            query: PyDAL query object

        Returns:
            Count of records matching query
        """
        loop = asyncio.get_event_loop()
        dal = self.read_dal if self.read_dal else self.dal

        def _count():
            try:
                return dal(query).count()
            except Exception as e:
                logger.error(f"Count error: {e}")
                raise

        return await loop.run_in_executor(self.executor, _count)

    async def executesql_async(self, sql: str, params: Optional[List] = None):
        """
        Execute raw SQL asynchronously.

        Args:
            sql: SQL query string
            params: Optional query parameters

        Returns:
            Query results
        """
        loop = asyncio.get_event_loop()

        def _execute():
            try:
                return self.dal.executesql(sql, placeholders=params)
            except Exception as e:
                logger.error(f"ExecuteSQL error: {e}")
                raise

        return await loop.run_in_executor(self.executor, _execute)

    @asynccontextmanager
    async def transaction_async(self):
        """
        Async context manager for database transactions.

        Usage:
            async with dal.transaction_async():
                await dal.insert_async(table, field1='value1')
                await dal.update_async(query, field2='value2')
        """
        loop = asyncio.get_event_loop()

        # Begin transaction
        await loop.run_in_executor(self.executor, lambda: None)

        try:
            yield self
            # Commit transaction
            await loop.run_in_executor(self.executor, self.dal.commit)
        except Exception as e:
            # Rollback on error
            await loop.run_in_executor(self.executor, self.dal.rollback)
            logger.error(f"Transaction rolled back: {e}")
            raise

    async def bulk_insert_async(self, table, records: List[Dict[str, Any]]):
        """
        Bulk insert records asynchronously.

        Args:
            table: PyDAL table object
            records: List of dictionaries with field values

        Returns:
            List of inserted record IDs
        """
        loop = asyncio.get_event_loop()

        def _bulk_insert():
            try:
                return table.bulk_insert(records)
            except Exception as e:
                logger.error(f"Bulk insert error: {e}")
                raise

        return await loop.run_in_executor(self.executor, _bulk_insert)

    async def close_async(self):
        """Close database connections and thread pool"""
        loop = asyncio.get_event_loop()

        def _close():
            self.dal.close()
            if self.read_dal:
                self.read_dal.close()

        await loop.run_in_executor(self.executor, _close)
        self.executor.shutdown(wait=True)
        logger.info("AsyncDAL connections closed")

    def __getattr__(self, name):
        """Proxy attribute access to underlying DAL"""
        return getattr(self.dal, name)


def init_database(
    uri: str,
    pool_size: int = 10,
    read_replica_uri: Optional[str] = None,
    folder: Optional[str] = None,
    migrate: bool = True
) -> AsyncDAL:
    """
    Initialize database with AsyncDAL wrapper.

    Args:
        uri: Primary database connection string
        pool_size: Connection pool size
        read_replica_uri: Optional read replica connection string
        folder: Folder for database files
        migrate: Enable automatic migrations

    Returns:
        Configured AsyncDAL instance
    """
    return AsyncDAL(
        uri=uri,
        pool_size=pool_size,
        folder=folder,
        migrate=migrate,
        read_replica_uri=read_replica_uri
    )
