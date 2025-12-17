# Quartermaster Inventory Service

Complete inventory management system for WaddleBot communities with checkout workflows, full-text search, and comprehensive audit logging.

## Overview

The **InventoryService** provides a production-ready inventory management system with:

- **CRUD Operations**: Create, read, update, delete inventory items
- **Checkout System**: Check out and return items with due dates
- **Stock Management**: Add/remove stock with audit trails
- **Full-Text Search**: PostgreSQL GIN index-based search
- **Filtering & Discovery**: Category, type, and availability filters
- **Audit Logging**: Immutable log of all operations
- **Checkout Tracking**: Monitor active, overdue, and historical checkouts
- **Async Support**: Built on AsyncDAL for non-blocking operations

## Files

### Core Service
- **`services/inventory_service.py`** (1,168 lines)
  - Main InventoryService class
  - All CRUD, checkout, search, and audit operations
  - Complete error handling and logging

### Documentation
- **`USAGE.md`** (581 lines)
  - Complete API reference
  - Usage examples for all methods
  - Error handling guide
  - Performance considerations

- **`EXAMPLES.py`** (619 lines)
  - 10 practical workflow examples
  - Complete E2E testing pattern
  - Real-world usage scenarios
  - Ready-to-use code snippets

## Installation

The service files are located at:
```
/home/penguin/code/WaddleBot/action/interactive/inventory_interaction_module/
├── services/
│   ├── __init__.py
│   └── inventory_service.py
├── __init__.py
├── USAGE.md
├── EXAMPLES.py
└── INVENTORY_SERVICE_README.md
```

## Database Setup

Run migration 014 to create required tables:

```bash
# Migration creates:
# - inventory_items: Item catalog
# - inventory_checkouts: Checkout records and returns
# - inventory_log: Immutable audit trail
# - Helper functions for inventory operations
```

Migration file: `/home/penguin/code/WaddleBot/config/postgres/migrations/014_add_quartermaster_tables.sql`

## Quick Start

### Initialize Service

```python
from flask_core import init_database
from action.interactive.inventory_interaction_module.services import InventoryService

# Setup database
dal = init_database(uri="postgresql://user:pass@localhost/waddlebot")

# Create service
inventory_service = InventoryService(dal)
```

### Add Item

```python
item = await inventory_service.add_item(
    community_id=1,
    name="Gaming Laptop",
    description="High-performance laptop",
    item_type="equipment",
    category="electronics",
    quantity=2,
    checkout_price=100,
    max_checkout_duration_hours=72,
    created_by_user_id=42
)
```

### Checkout Item

```python
checkout = await inventory_service.checkout_item(
    community_id=1,
    item_id=5,
    user_id=100,
    quantity=1,
    checkout_duration_hours=48
)
```

### Return Item

```python
returned = await inventory_service.checkin_item(
    community_id=1,
    checkout_id=10,
    returned_condition="Good"
)
```

## API Methods

### Item Management

| Method | Purpose |
|--------|---------|
| `add_item()` | Create new inventory item |
| `get_item()` | Retrieve item details |
| `update_item()` | Update item properties |
| `delete_item()` | Soft delete item |

### Checkout Operations

| Method | Purpose |
|--------|---------|
| `checkout_item()` | Check out item(s) |
| `checkin_item()` | Return checked out item(s) |
| `get_active_checkouts()` | Get current active checkouts |
| `get_overdue_checkouts()` | Get overdue items |
| `get_user_checkouts()` | Get user's checkout history |

### Stock Management

| Method | Purpose |
|--------|---------|
| `add_stock()` | Add inventory stock |
| `remove_stock()` | Remove inventory stock |

### Search & Discovery

| Method | Purpose |
|--------|---------|
| `search_items()` | Full-text search items |
| `get_items_by_category()` | Filter by category |
| `get_items_by_type()` | Filter by item type |
| `get_available_items()` | Get items with stock |
| `get_low_stock_items()` | Get items with low availability |

### Reporting & Analytics

| Method | Purpose |
|--------|---------|
| `get_inventory_summary()` | Get comprehensive stats |
| `get_audit_log()` | Get operation history |

## Data Models

### Item

```python
{
    'id': int,
    'community_id': int,
    'name': str,
    'description': str,
    'item_type': str,  # equipment, consumable, collectible
    'category': str,
    'quantity': int,  # Total in inventory
    'available_quantity': int,  # Available for checkout
    'checkout_price': int,  # Community currency cost
    'max_checkout_duration_hours': int,
    'image_url': str,
    'metadata': dict,  # Custom fields
    'created_at': datetime,
    'updated_at': datetime
}
```

### Checkout

```python
{
    'id': int,
    'item_id': int,
    'user_id': int,
    'quantity': int,
    'checked_out_at': datetime,
    'due_at': datetime,
    'returned_at': datetime,
    'status': str,  # active, returned, overdue
    'notes': str
}
```

### Audit Log

```python
{
    'id': int,
    'item_id': int,
    'user_id': int,
    'community_id': int,
    'action': str,  # checkout, return, add_stock, remove_stock, update, delete
    'quantity_change': int,
    'details': dict,
    'created_at': datetime
}
```

## Key Features

### 1. Full-Text Search

Uses PostgreSQL GIN index for efficient searching:

```python
results = await inventory_service.search_items(
    community_id=1,
    query="gaming laptop",
    limit=20
)
```

Searches across: name, description, category, item_type

### 2. Checkout Management

Complete checkout lifecycle:

```python
# Check availability
item = await inventory_service.get_item(1, 5)

# Checkout
checkout = await inventory_service.checkout_item(1, 5, 100)

# Track
overdue = await inventory_service.get_overdue_checkouts(1)

# Return
returned = await inventory_service.checkin_item(1, checkout['id'])
```

### 3. Audit Trail

Immutable log of all operations:

```python
logs = await inventory_service.get_audit_log(
    community_id=1,
    action='checkout',
    limit=100
)

for log in logs:
    print(f"{log['action']}: Item {log['item_id']} by User {log['user_id']}")
```

### 4. Stock Management

Track and update inventory:

```python
# Add stock
updated = await inventory_service.add_stock(
    community_id=1,
    item_id=5,
    quantity=10,
    reason="Restocking"
)

# Remove stock
updated = await inventory_service.remove_stock(
    community_id=1,
    item_id=5,
    quantity=2,
    reason="Damaged"
)
```

### 5. Community Currency Integration

Checkout pricing support:

```python
# Item has checkout_price in community currency
item = await inventory_service.get_item(1, 5)

if item['checkout_price'] > 0:
    # Deduct from user's currency balance
    await currency_service.deduct(user_id, item['checkout_price'])
```

## Performance

### Database Indexes

Optimized queries with strategic indexes:

- `idx_inventory_items_community`: Community lookups
- `idx_inventory_items_active`: Recent items
- `idx_inventory_items_category`: Category/type filtering
- `idx_inventory_items_stock`: Low stock queries
- `idx_inventory_items_search`: Full-text search (GIN)
- `idx_inventory_checkouts_active`: Active/overdue tracking
- `idx_inventory_checkouts_item`: Item-specific history
- `idx_inventory_checkouts_user`: User history
- `idx_inventory_log_*`: Audit trail queries

### Async Operations

All methods use AsyncDAL for non-blocking operations:

```python
# Truly async - no blocking
items = await inventory_service.get_available_items(community_id=1)
checkout = await inventory_service.checkout_item(...)
logs = await inventory_service.get_audit_log(...)
```

### Connection Pooling

AsyncDAL manages connection pooling automatically:

```python
dal = init_database(
    uri="postgresql://...",
    pool_size=10  # Connection pool
)
```

## Error Handling

All methods raise exceptions for error cases:

```python
try:
    checkout = await inventory_service.checkout_item(...)
except ValueError as e:
    # Input validation errors (item not found, insufficient stock)
    print(f"Invalid request: {e}")
except Exception as e:
    # Database errors
    print(f"Database error: {e}")
```

## Common Workflows

### Setup New Community Inventory

```python
items = []
for item_data in inventory_list:
    item = await inventory_service.add_item(
        community_id=1,
        created_by_user_id=1,
        **item_data
    )
    items.append(item)
```

### Member Checkout

```python
# Check availability
item = await inventory_service.get_item(1, 5)
if item['available_quantity'] > 0:
    # Checkout
    checkout = await inventory_service.checkout_item(
        community_id=1,
        item_id=5,
        user_id=100,
        checkout_duration_hours=48
    )
```

### Inventory Dashboard

```python
summary = await inventory_service.get_inventory_summary(1)
overdue = await inventory_service.get_overdue_checkouts(1)
low_stock = await inventory_service.get_low_stock_items(1)

print(f"Available: {summary['total_available']}")
print(f"Overdue: {summary['overdue_checkouts']}")
print(f"Low stock items: {summary['low_stock_items']}")
```

### Restock Items

```python
await inventory_service.add_stock(
    community_id=1,
    item_id=5,
    quantity=20,
    reason="Monthly restock",
    added_by_user_id=1
)
```

## Advanced Usage

### Metadata Storage

Store custom item properties in metadata:

```python
item = await inventory_service.add_item(
    community_id=1,
    name="Blue Laptop",
    metadata={
        'color': 'blue',
        'weight_kg': 2.5,
        'warranty_until': '2026-12-31',
        'serial_number': 'ABC123XYZ'
    }
)
```

### Conditional Filtering

```python
# Include unavailable items
all_items = await inventory_service.get_items_by_category(
    community_id=1,
    category="electronics",
    include_unavailable=True
)

# Only available items
available = await inventory_service.get_items_by_category(
    community_id=1,
    category="electronics",
    include_unavailable=False
)
```

### Audit Trail Analysis

```python
# Get specific user's actions
user_logs = await inventory_service.get_audit_log(
    community_id=1,
    user_id=42
)

# Get item history
item_logs = await inventory_service.get_audit_log(
    community_id=1,
    item_id=5
)

# Get specific action type
returns = await inventory_service.get_audit_log(
    community_id=1,
    action='return'
)
```

## Testing

Use the provided `EXAMPLES.py` for testing:

```python
from action.interactive.inventory_interaction_module.EXAMPLES import InventoryExamples

examples = InventoryExamples(inventory_service)

# Run complete workflow test
await examples.run_complete_workflow(community_id=1)
```

Available examples:
- `setup_new_community_inventory()`: Initial setup
- `member_checkout_workflow()`: Complete checkout flow
- `member_return_workflow()`: Return process
- `search_inventory()`: Search functionality
- `browse_category()`: Category browsing
- `generate_inventory_report()`: Dashboard data
- `restock_item()`: Stock management
- `view_user_history()`: User history
- `review_audit_log()`: Audit analysis
- `run_complete_workflow()`: End-to-end test

## Integration Points

### Community Currency

```python
# After successful checkout
checkout = await inventory_service.checkout_item(...)

if checkout_item['checkout_price'] > 0:
    # Deduct currency
    await currency_service.deduct_balance(
        user_id=user_id,
        community_id=1,
        amount=checkout_item['checkout_price']
    )
```

### Notifications

```python
# Monitor overdue items
overdue = await inventory_service.get_overdue_checkouts(1)
for checkout in overdue:
    await notify_service.send_reminder(
        user_id=checkout['user_id'],
        message=f"Item {checkout['item_id']} is overdue!"
    )
```

### Reporting

```python
# Generate reports
summary = await inventory_service.get_inventory_summary(1)
logs = await inventory_service.get_audit_log(1, limit=1000)

# Pass to reporting service
await reporting_service.generate_inventory_report(summary, logs)
```

## Troubleshooting

### Item Not Found
- Verify community_id matches
- Check item hasn't been soft deleted (deleted_at IS NULL)

### Insufficient Quantity
- Note: available_quantity = quantity - checked_out_items
- Check available_quantity, not total quantity

### Checkout Not Found
- Verify status is 'active' (not returned)
- Check community_id matches

## Best Practices

1. **Always await**: All methods are async
2. **Validate input**: Check IDs before operations
3. **Handle errors**: Implement proper exception handling
4. **Log operations**: Use audit log for compliance
5. **Monitor stock**: Regular low stock checks
6. **Track overdue**: Daily overdue checkout monitoring
7. **Test workflows**: Use EXAMPLES.py patterns
8. **Use metadata**: Store custom properties in metadata field

## Configuration

Service uses AsyncDAL with configurable pool size:

```python
dal = init_database(
    uri="postgresql://user:pass@localhost/waddlebot",
    pool_size=10,  # Tune based on concurrency
    read_replica_uri=None,  # Optional read replica
    migrate=True
)
```

## Performance Tuning

### Connection Pool Size
Adjust based on concurrent operations:
- 5-10: Low traffic communities
- 10-20: Medium traffic
- 20+: High traffic communities

### Query Optimization
- Use full-text search for discovery
- Filter before fetching results
- Limit results with LIMIT clause
- Use indexes for filtering

## Support & Documentation

- **API Reference**: See `USAGE.md`
- **Examples**: See `EXAMPLES.py`
- **Database**: Migration 014 defines schema
- **Code**: Comprehensive inline documentation

## License

Part of WaddleBot project

## Version

Service Version: 1.0.0
Tested with: PostgreSQL 13+, Python 3.9+

---

Created for WaddleBot's Quartermaster inventory system.
For detailed API documentation, see `USAGE.md`.
For practical examples, see `EXAMPLES.py`.
