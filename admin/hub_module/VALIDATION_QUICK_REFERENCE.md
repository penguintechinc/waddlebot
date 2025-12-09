# Validation Middleware Quick Reference

## Import Statement

```javascript
import { validators, validationRules, validateRequest } from '../middleware/validation.js';
```

## Basic Pattern

```javascript
router.post('/endpoint',
  requireAuth,                          // Authentication middleware
  validators.text('field_name', { min: 3, max: 255 }),  // Validators
  validators.integer('count', { min: 1, max: 100 }),
  validateRequest,                      // REQUIRED: Handles validation errors
  controllerFunction                    // Your controller
);
```

## Available Validators

### Text & String Validation

```javascript
// Text with length constraints
validators.text('name', { min: 3, max: 100 })
validators.text('description', { min: 0, max: 5000 })

// Email
validators.email()

// Username
validators.username()

// URL
validators.url('website')
validators.url('logo_url')

// JSON string
validators.jsonString('config')
validators.jsonString('definition')

// Hex color
validators.hexColor('primary_color')
validators.hexColor('background_color')
```

### Number Validation

```javascript
// Integer with optional min/max
validators.integer('age', { min: 18, max: 120 })
validators.integer('count')

// Positive integer (> 0)
validators.positiveInteger('price')
validators.positiveInteger('quantity')
```

### Boolean Validation

```javascript
validators.boolean('is_active')
validators.boolean('enabled')
```

### Array Validation

```javascript
// Array of integers
validators.arrayOfIntegers('user_ids')

// Array of strings with optional length
validators.arrayOfStrings('tags')
validators.arrayOfStrings('categories', 1, 50)
```

### Date & Time

```javascript
// Date range (validates both start_date and end_date)
...validators.dateRange()
```

### Other

```javascript
// UUID
validators.uuid('workflow_id')
validators.uuid()  // defaults to 'id'

// Pagination
validators.pagination()  // validates limit and offset query params
```

## Pre-configured Validation Rules

```javascript
// Authentication
validationRules.login              // email + password
validationRules.register           // email + username + password

// Community
validationRules.createCommunity    // name + display_name + description + urls

// Announcements
validationRules.createAnnouncement // title + content + type + priority + flags

// Pagination
validationRules.pagination         // limit + offset query params
```

## Common Examples

### Simple POST with text and boolean

```javascript
router.post('/items',
  requireAuth,
  validators.text('name', { min: 3, max: 255 }),
  validators.text('description', { min: 0, max: 1000 }),
  validators.boolean('is_active'),
  validateRequest,
  itemController.createItem
);
```

### PUT with multiple field types

```javascript
router.put('/settings',
  requireAuth,
  validators.text('title', { min: 1, max: 255 }),
  validators.hexColor('primary_color'),
  validators.integer('refresh_interval', { min: 1000, max: 60000 }),
  validators.boolean('enabled'),
  validateRequest,
  settingsController.updateSettings
);
```

### Complex validation with arrays

```javascript
router.post('/workflow',
  requireAuth,
  validators.text('name', { min: 3, max: 255 }),
  validators.jsonString('definition'),
  validators.arrayOfStrings('tags'),
  validators.boolean('is_active'),
  validateRequest,
  workflowController.createWorkflow
);
```

### Date range validation

```javascript
router.post('/giveaway',
  requireAuth,
  validators.text('title', { min: 3, max: 255 }),
  validators.positiveInteger('entry_cost'),
  ...validators.dateRange(),  // Note the spread operator!
  validateRequest,
  giveawayController.createGiveaway
);
```

## Error Response Format

When validation fails, the API returns:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request data",
    "details": [
      {
        "msg": "name must be between 3 and 255 characters",
        "param": "name",
        "location": "body"
      }
    ]
  }
}
```

## Important Notes

1. **Always include `validateRequest`** middleware after validators
2. **Use spread operator** for validators that return arrays (e.g., `...validators.dateRange()`)
3. **Optional fields** - Add `.optional()` to validator if field is not required
4. **Order matters** - Validators run before `validateRequest`, which runs before controller
5. **Query params** - Use `validators.pagination()` for GET routes with limit/offset

## Optional Field Example

```javascript
router.put('/profile',
  requireAuth,
  validators.text('display_name', { min: 2, max: 255 }),
  validators.text('bio', { min: 0, max: 1000 }).optional(),  // Bio is optional
  validators.url('website').optional(),                      // Website is optional
  validateRequest,
  profileController.updateProfile
);
```

## Adding Custom Validators

To add a new validator to `validation.js`:

```javascript
// In validators object
customValidator: (fieldName, options = {}) =>
  body(fieldName)
    .custom((value) => {
      // Your validation logic
      if (!isValid(value)) {
        throw new Error('Validation failed');
      }
      return true;
    })
    .withMessage(`${fieldName} validation message`),
```

## Testing Validation

```bash
# Use curl or your API client
curl -X POST http://localhost:3000/api/endpoint \
  -H "Content-Type: application/json" \
  -d '{"invalid": "data"}'

# Should return 400 with validation error details
```

---

**Last Updated**: 2025-12-09
**Full Documentation**: See VALIDATION_ENHANCEMENT_SUMMARY.md
