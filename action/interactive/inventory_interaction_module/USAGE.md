# Quartermaster Inventory Service Usage Guide

Complete documentation for the WaddleBot Inventory Service, supporting inventory management with checkout workflows and audit logging.

## Overview

The `InventoryService` provides comprehensive inventory management for WaddleBot communities. It supports:

- **Item Management**: Create, read, update, and delete inventory items
- **Checkout System**: Check out and return items with due dates
- **Stock Management**: Add/remove stock with audit trails
- **Advanced Search**: Full-text search using PostgreSQL GIN indexes
- **Filtering**: Get items by category, type, or availability status
- **Audit Logging**: Complete immutable log of all inventory operations
- **Checkout Tracking**: Monitor active, overdue, and historical checkouts

## Installation

The service is located at:
```
/home/penguin/code/WaddleBot/action/interactive/inventory_interaction_module/services/inventory_service.py
```

## Database Setup

The service requires migration 014 tables to be created. Run the migration:

```sql
-- Creates three main tables:
-- inventory_items: Stores inventory items
-- inventory_checkouts: Tracks item checkouts and returns
-- inventory_log: Audit trail of all operations
```

## Basic Usage

### Initialize the Service

```python
from flask_core import init_database
from action.interactive.inventory_interaction_module.services import InventoryService

# Initialize AsyncDAL
dal = init_database(
    uri="postgresql://user:pass@localhost/waddlebot",
    pool_size=10
)

# Create service instance
inventory_service = InventoryService(dal)
```

### Create an Item

```python
item = await inventory_service.add_item(
    community_id=1,
    name="Gaming Laptop",
    description="High-performance laptop for community gaming events",
    item_type="equipment",
    category="electronics",
    quantity=2,
    checkout_price=100,  # Community currency cost
    max_checkout_duration_hours=48,
    image_url="https://example.com/laptop.jpg",
    created_by_user_id=42
)

print(f"Created item {item['id']}: {item['name']}")
```

### Get an Item

```python
item = await inventory_service.get_item(
    community_id=1,
    item_id=5
)

if item:
    print(f"Item: {item['name']}")
    print(f"Available: {item['available_quantity']}/{item['quantity']}")
else:
    print("Item not found")
```

### Update an Item

```python
updated_item = await inventory_service.update_item(
    community_id=1,
    item_id=5,
    checkout_price=150,
    description="Updated description",
    updated_by_user_id=42
)

print(f"Updated: {updated_item['name']}")
```

### Delete an Item

```python
success = await inventory_service.delete_item(
    community_id=1,
    item_id=5,
    deleted_by_user_id=42
)

if success:
    print("Item deleted (soft delete)")
```

## Checkout/Checkin Workflows

### Checkout an Item

```python
checkout = await inventory_service.checkout_item(
    community_id=1,
    item_id=5,
    user_id=100,
    quantity=1,
    checkout_duration_hours=48,  # Due in 48 hours
    notes="For streaming setup"
)

print(f"Checkout {checkout['id']} created")
print(f"Due at: {checkout['due_at']}")
```

### Checkin an Item

```python
returned = await inventory_service.checkin_item(
    community_id=1,
    checkout_id=5,
    quantity=1,  # Return all if None
    returned_condition="Good",
    returned_by_user_id=100
)

print(f"Checkout {returned['id']} returned")
print(f"Status: {returned['status']}")
```

## Stock Management

### Add Stock

```python
updated_item = await inventory_service.add_stock(
    community_id=1,
    item_id=5,
    quantity=5,
    reason="Monthly restock",
    added_by_user_id=42
)

print(f"New quantity: {updated_item['quantity']}")
print(f"Available: {updated_item['available_quantity']}")
```

### Remove Stock

```python
updated_item = await inventory_service.remove_stock(
    community_id=1,
    item_id=5,
    quantity=2,
    reason="Damaged items disposed",
    removed_by_user_id=42
)

print(f"Updated quantity: {updated_item['quantity']}")
```

## Search and Filtering

### Full-Text Search

Uses PostgreSQL GIN index for efficient searching across name, description, category, and type:

```python
results = await inventory_service.search_items(
    community_id=1,
    query="gaming laptop",
    limit=20
)

for item in results:
    print(f"- {item['name']}: {item['description']}")
```

### Get Items by Category

```python
electronics = await inventory_service.get_items_by_category(
    community_id=1,
    category="electronics",
    include_unavailable=False  # Only items with available_quantity > 0
)

for item in electronics:
    print(f"- {item['name']}: {item['available_quantity']}/{item['quantity']}")
```

### Get Items by Type

```python
equipment = await inventory_service.get_items_by_type(
    community_id=1,
    item_type="equipment",
    include_unavailable=False
)

for item in equipment:
    print(f"- {item['name']}")
```

### Get Available Items

```python
available = await inventory_service.get_available_items(
    community_id=1,
    limit=50
)

for item in available:
    print(f"- {item['name']}: {item['available_quantity']} available")
```

### Get Low Stock Items

```python
low_stock = await inventory_service.get_low_stock_items(
    community_id=1
)

for item in low_stock:
    checked_out = item['quantity'] - item['available_quantity']
    print(f"- {item['name']}: {checked_out}/{item['quantity']} checked out")
```

## Checkout Tracking

### Get Active Checkouts

```python
# All active checkouts
active = await inventory_service.get_active_checkouts(
    community_id=1
)

# For specific user
user_checkouts = await inventory_service.get_active_checkouts(
    community_id=1,
    user_id=100
)

for checkout in user_checkouts:
    print(f"- Item {checkout['item_id']}: Due {checkout['due_at']}")
```

### Get Overdue Checkouts

```python
overdue = await inventory_service.get_overdue_checkouts(
    community_id=1
)

for checkout in overdue:
    print(f"- Item {checkout['item_id']} (User {checkout['user_id']}) "
          f"due at {checkout['due_at']}")
```

### Get User Checkout History

```python
# All checkouts for user
history = await inventory_service.get_user_checkouts(
    community_id=1,
    user_id=100
)

# Only active checkouts
active = await inventory_service.get_user_checkouts(
    community_id=1,
    user_id=100,
    status='active'
)

# Only returned items
returned = await inventory_service.get_user_checkouts(
    community_id=1,
    user_id=100,
    status='returned'
)

for checkout in history:
    print(f"- Item {checkout['item_id']}: {checkout['status']}")
```

## Inventory Summary

### Get Community Inventory Summary

```python
summary = await inventory_service.get_inventory_summary(
    community_id=1
)

print(f"Total items: {summary['total_items']}")
print(f"Total quantity: {summary['total_quantity']}")
print(f"Available: {summary['total_available']}")
print(f"Active checkouts: {summary['active_checkouts']}")
print(f"Overdue: {summary['overdue_checkouts']}")
print(f"Low stock items: {summary['low_stock_items']}")
```

## Audit Logging

### Get Audit Log

```python
# All actions in community
logs = await inventory_service.get_audit_log(
    community_id=1,
    limit=100
)

# For specific item
item_logs = await inventory_service.get_audit_log(
    community_id=1,
    item_id=5,
    limit=50
)

# For specific user
user_logs = await inventory_service.get_audit_log(
    community_id=1,
    user_id=42,
    limit=50
)

# Specific action type
checkout_logs = await inventory_service.get_audit_log(
    community_id=1,
    action='checkout',
    limit=100
)

for log in logs:
    print(f"[{log['created_at']}] {log['action']}: "
          f"Item {log['item_id']} by User {log['user_id']}")
    print(f"  Change: {log['quantity_change']}")
    print(f"  Details: {log['details']}")
```

## API Response Examples

### Item Response

```python
{
    'id': 5,
    'community_id': 1,
    'name': 'Gaming Laptop',
    'description': 'High-performance laptop',
    'item_type': 'equipment',
    'category': 'electronics',
    'quantity': 2,  # Total in inventory
    'available_quantity': 1,  # Available for checkout (1 is checked out)
    'checkout_price': 100,  # Community currency
    'max_checkout_duration_hours': 48,
    'image_url': 'https://example.com/laptop.jpg',
    'metadata': {},
    'created_at': datetime(...),
    'updated_at': datetime(...)
}
```

### Checkout Response

```python
{
    'id': 10,
    'item_id': 5,
    'user_id': 100,
    'quantity': 1,
    'checked_out_at': datetime(...),
    'due_at': datetime(...),  # None if no max duration
    'status': 'active',  # or 'returned' or 'overdue'
    'notes': 'For streaming setup'
}
```

### Audit Log Response

```python
{
    'id': 45,
    'item_id': 5,
    'user_id': 42,
    'community_id': 1,
    'action': 'checkout',  # or 'return', 'add_stock', 'remove_stock', 'update', 'delete'
    'quantity_change': -1,  # Negative for checkout, positive for return
    'details': {
        'quantity': 1,
        'notes': 'For streaming setup'
    },
    'created_at': datetime(...)
}
```

## Error Handling

All service methods raise exceptions on failure. Implement proper error handling:

```python
try:
    checkout = await inventory_service.checkout_item(
        community_id=1,
        item_id=5,
        user_id=100,
        quantity=5
    )
except ValueError as e:
    print(f"Invalid request: {e}")
    # Item not found, insufficient quantity, etc.
except Exception as e:
    print(f"Database error: {e}")
```

Common error scenarios:

- **ValueError**: Invalid input (negative quantity, item not found, insufficient stock)
- **Exception**: Database operations failed

## Database Functions

The service leverages PostgreSQL functions for data integrity:

- `update_inventory_on_checkout()`: Manages checkout with quantity validation
- `update_inventory_on_return()`: Manages returns with validation
- `add_inventory_stock()`: Adds stock with audit logging
- `remove_inventory_stock()`: Removes stock with validation
- `get_inventory_summary()`: Retrieves comprehensive statistics
- `search_inventory_items()`: Full-text search using GIN index

## Performance Considerations

### Indexes

The migration creates optimized indexes:

- `idx_inventory_items_community`: Community lookups
- `idx_inventory_items_active`: Recent items
- `idx_inventory_items_category`: Category/type filtering
- `idx_inventory_items_stock`: Low stock queries
- `idx_inventory_items_search`: Full-text search (GIN)
- `idx_inventory_checkouts_active`: Active/overdue checkouts
- `idx_inventory_checkouts_item`: Item-specific checkouts
- `idx_inventory_checkouts_user`: User checkout history
- `idx_inventory_log_*`: Audit trail queries

### Async Operations

All methods are async using AsyncDAL:

```python
# Use with asyncio
import asyncio

async def main():
    item = await inventory_service.add_item(...)
    checkouts = await inventory_service.get_active_checkouts(...)

asyncio.run(main())
```

## Integration with Community Currency

Checkout pricing is stored but currency deduction must be handled separately:

```python
# After successful checkout
checkout = await inventory_service.checkout_item(
    community_id=1,
    item_id=5,
    user_id=100,
    quantity=1
)

if checkout['item']['checkout_price'] > 0:
    # Deduct from user's currency balance
    # Use CommunityService or currency module
    await currency_service.deduct_balance(
        user_id=100,
        community_id=1,
        amount=checkout['item']['checkout_price'],
        reason=f"Checkout: {item['name']}"
    )
```

## Best Practices

1. **Always use async/await**: All methods must be awaited in async context
2. **Validate input**: Check community_id and user_id exist before operations
3. **Handle errors gracefully**: Catch exceptions and provide user feedback
4. **Log important actions**: Use audit log for compliance tracking
5. **Monitor overdue items**: Regularly check for and notify about overdue checkouts
6. **Maintain stock levels**: Monitor low stock items and reorder as needed
7. **Test transactions**: Verify checkout/checkin workflows in test environments
8. **Use metadata**: Store custom item properties in metadata JSON field

## Common Patterns

### Bulk Operations

```python
# Add multiple items
items = []
for item_data in item_list:
    item = await inventory_service.add_item(
        community_id=1,
        **item_data
    )
    items.append(item)
```

### Search and Process

```python
# Find items and check stock
results = await inventory_service.search_items(
    community_id=1,
    query="laptop"
)

for item in results:
    if item['available_quantity'] < 2:
        # Handle low stock
        pass
```

### Checkout Workflow

```python
# Check availability
item = await inventory_service.get_item(1, 5)
if item['available_quantity'] > 0:
    # Process checkout
    checkout = await inventory_service.checkout_item(
        community_id=1,
        item_id=5,
        user_id=100,
        checkout_duration_hours=72
    )
    # Return checkout ID to user
```

## Troubleshooting

### "Item not found or community mismatch"
- Verify item_id exists in specified community
- Check soft delete status (deleted_at IS NULL)

### "Insufficient quantity available"
- Check available_quantity (not total quantity)
- Note: available_quantity = quantity - checked_out_items

### "Checkout not found or already processed"
- Verify checkout exists and status is 'active'
- Check user has correct community_id

### "Cannot remove more than available quantity"
- Don't include quantity in SQL - let stored procedure validate
- Total quantity must be >= available_quantity

For additional help, check the audit log for recent operations using `get_audit_log()`.
