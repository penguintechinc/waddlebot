# Workflow Validation Service Documentation

## Overview

The `WorkflowValidationService` provides comprehensive validation for workflow definitions, ensuring correctness, security, and performance before workflow execution.

## Features

### 1. Graph Structure Validation
- **DAG Detection**: Ensures workflows form a Directed Acyclic Graph (allows loop nodes)
- **Cycle Detection**: Detects prohibited cycles while permitting valid loop constructs
- **Reachability Analysis**: Confirms all nodes are reachable from trigger nodes
- **Orphaned Node Detection**: Identifies unreachable nodes
- **Depth Calculation**: Validates workflow depth doesn't exceed limits

### 2. Node Configuration Validation
Each node type has specific validation rules:

#### Trigger Nodes
- **Command**: Non-empty pattern, at least one platform
- **Event**: Non-empty event type, platform specification
- **Webhook**: Valid path (starts with `/`)
- **Schedule**: Valid cron expression format

#### Condition Nodes
- **If**: At least one condition rule defined
- **Switch**: Non-empty variable, at least one case
- **Filter**: Valid array variable, filter condition, output variable

#### Action Nodes
- **Module**: Non-empty module name, valid timeout
- **Webhook**: Valid URL format, positive timeout, non-negative retries
- **Chat Message**: Non-empty template, valid destination config
- **Browser Source**: Valid source type and action, positive duration
- **Delay**: Non-negative delay, warning on zero delay without variable

#### Data Nodes
- **Transform**: At least one transformation, valid expression language
- **Variable Set**: At least one variable specified
- **Variable Get**: Non-empty variable and output names

#### Loop Nodes
- **Foreach**: Non-empty array variable, valid iteration limit
- **While**: Condition specified, valid iteration limit
- **Break**: Optional condition validation

#### Flow Nodes
- **Merge**: Valid input port requirements
- **Parallel**: Valid execution type, positive timeout
- **End**: Non-empty output port name

### 3. Connection Validation
- **Node Existence**: Both source and target nodes exist
- **Port Existence**: Both source and target ports exist
- **Port Types**: Output port connects to input port
- **Type Compatibility**: Data types are compatible
- **Conditional Expressions**: Valid conditional syntax

### 4. Trigger Configuration Validation
- Ensures at least one trigger node exists
- Validates trigger-specific settings
- Warns if triggers can't reach end nodes

### 5. Complexity Limits
- **Maximum Nodes**: 100 nodes per workflow (configurable)
- **Maximum Depth**: 10 levels recommended (warns above)
- **Loop Iterations**: 10,000 maximum iterations (safety limit)

### 6. Security Validation
Scans for dangerous code patterns in:
- Data transformation expressions
- Condition values
- Webhook body templates

Detected patterns:
- `__import__`, `eval()`, `exec()`, `compile()`
- `os.system()`, `subprocess.*`
- `open()`, `input()`
- `__code__`, `__dict__`, `__builtins__`, `globals()`, `locals()`, `vars()`

## API Usage

### Basic Usage

```python
from services.validation_service import WorkflowValidationService
from models.workflow import WorkflowDefinition

# Create validation service
validator = WorkflowValidationService()

# Validate workflow
result = validator.validate_workflow(workflow_def)

# Check results
if result.is_valid:
    print("Workflow is valid!")
else:
    print("Validation errors:")
    for error in result.errors:
        print(f"  - {error}")

    print("\nValidation warnings:")
    for warning in result.warnings:
        print(f"  - {warning}")

    print("\nNode-specific errors:")
    for node_id, errors in result.node_validation_errors.items():
        print(f"  {node_id}:")
        for error in errors:
            print(f"    - {error}")
```

### ValidationResult Object

```python
@dataclass
class ValidationResult:
    is_valid: bool                              # Overall validity
    errors: List[str]                           # Global errors
    warnings: List[str]                         # Global warnings
    node_validation_errors: Dict[str, List[str]]  # Node-specific errors
```

Methods:
- `add_error(message: str)`: Add error and mark invalid
- `add_warning(message: str)`: Add warning
- `add_node_error(node_id: str, message: str)`: Add node-specific error
- `to_dict()`: Convert to JSON-serializable dict

### JSON Serialization

```python
result = validator.validate_workflow(workflow_def)
result_dict = result.to_dict()

# Result dict contains:
{
    "is_valid": bool,
    "errors": [str, ...],
    "warnings": [str, ...],
    "node_validation_errors": {
        "node_id": [str, ...]
    },
    "error_count": int,
    "warning_count": int
}
```

## Validation Rules by Category

### Graph Structure Rules
1. Workflow must have at least one node
2. No cycles allowed (except within loop nodes)
3. All nodes must be reachable from at least one trigger
4. Triggers should be able to reach end nodes
5. Maximum 100 nodes
6. Maximum depth of 10 recommended

### Node Rules
1. All nodes must have non-empty labels
2. All nodes must have position (x, y)
3. Each node type has specific configuration requirements
4. Input/output ports must be properly defined

### Connection Rules
1. Source and target nodes must exist
2. Source port must be an output port
3. Target port must be an input port
4. Port names must match (on both nodes)
5. Data types should be compatible
6. Port types must match (input to output)

### Type Compatibility
- Same types: Always compatible
- ANY type: Compatible with everything
- OBJECT ↔ ARRAY: Loosely compatible
- Different types: Warning (but allowed)

### Security Rules
- No dangerous Python patterns in expressions
- No external command execution patterns
- No code reflection patterns
- No builtin override patterns

## Common Validation Errors

### Graph Structure
```
"Cycle detected in workflow: node_a -> node_b -> node_a"
"Unreachable nodes found (orphaned): node_3, node_4"
"Trigger node trigger_1 cannot reach any end nodes"
```

### Missing/Invalid Configuration
```
"Command pattern cannot be empty"
"At least one platform must be specified"
"Invalid URL: not-a-valid-url"
"Invalid cron expression: bad cron"
```

### Connection Issues
```
"Connection references non-existent node: node_999"
"Node trigger_1 has no output port: success_port"
"Node action_1 has no input port: data_input"
```

### Complexity Issues
```
"Workflow exceeds maximum node count: 101 > 100"
"Workflow depth (15) exceeds recommended maximum (10)"
```

### Security Issues
```
"Potential security issue in transformation 'result': contains dangerous patterns"
"Potential security issue in condition: contains dangerous patterns"
```

## Configuration

### Adjustable Limits

```python
class WorkflowValidationService:
    MAX_NODES = 100              # Max nodes per workflow
    MAX_DEPTH = 10               # Recommended max depth
    MAX_LOOP_ITERATIONS = 10000  # Safety limit for loops
```

To change limits, subclass the service:

```python
class CustomValidator(WorkflowValidationService):
    MAX_NODES = 200
    MAX_DEPTH = 20
    MAX_LOOP_ITERATIONS = 50000
```

## Logging

The service provides comprehensive logging:

```python
import logging

logger = logging.getLogger("services.validation_service")
logger.setLevel(logging.INFO)

# Logs include:
# - Validation start/completion
# - Error detection
# - Security issues
# - Unexpected errors
```

### Log Levels
- **DEBUG**: Detailed validation progress
- **INFO**: Validation start/completion, summary
- **WARNING**: Non-critical issues, unsafe patterns
- **ERROR**: Critical validation failures, unexpected errors

## Testing

Run comprehensive test suite:

```bash
python3 services/validation_service_tests.py
```

Or with pytest:

```bash
pytest services/validation_service_tests.py -v
```

### Test Coverage
- Valid workflow validation
- Missing trigger nodes
- Invalid connections
- Cycle detection
- Node configuration validation
- Complexity limits
- Security validation
- Cron expression validation

## Integration with Workflow System

### In Controllers
```python
from services.validation_service import WorkflowValidationService

@app.route("/workflows", methods=["POST"])
def create_workflow():
    workflow_data = request.json
    workflow_def = WorkflowDefinition.from_dict(workflow_data)

    validator = WorkflowValidationService()
    result = validator.validate_workflow(workflow_def)

    if not result.is_valid:
        return {
            "error": "Workflow validation failed",
            "details": result.to_dict()
        }, 400

    # Proceed with workflow creation
    save_workflow(workflow_def)
    return {"success": True, "workflow_id": workflow_def.metadata.workflow_id}
```

### In Execution Engine
```python
def execute_workflow(workflow_def: WorkflowDefinition):
    # Always validate before execution
    validator = WorkflowValidationService()
    result = validator.validate_workflow(workflow_def)

    if not result.is_valid:
        logger.error(f"Cannot execute invalid workflow: {result.errors}")
        raise WorkflowValidationError(result.to_dict())

    # Execute workflow
    executor = WorkflowExecutor(workflow_def)
    executor.run()
```

## Performance Considerations

- **Time Complexity**: O(n + e) where n = nodes, e = connections
- **Space Complexity**: O(n) for tracking visited nodes
- **Cycle Detection**: Uses DFS with recursion stack
- **Reachability**: BFS for each trigger node

For large workflows (100+ nodes):
- Validation typically completes in < 100ms
- Consider caching validation results
- Validate during workflow creation, not execution

## Best Practices

1. **Always Validate**: Validate workflows before saving or executing
2. **Handle Warnings**: Address warnings even if workflow is technically valid
3. **Security First**: Never ignore security validation errors
4. **Type Checking**: Ensure port type compatibility for data flow
5. **Testing**: Test workflows with validation service before deployment
6. **Error Handling**: Provide meaningful error messages to users
7. **Logging**: Enable INFO logging to track validation issues

## Troubleshooting

### Workflow Validation Fails But Should Be Valid

1. Check all node IDs are unique
2. Verify port names match exactly (case-sensitive)
3. Ensure all ports have data types specified
4. Check data type compatibility between connections
5. Verify trigger nodes are properly configured

### False Security Positives

The service uses simple pattern matching for security. To reduce false positives:

1. Use JQ for expressions (safer than Python/JS)
2. Avoid dangerous keywords even in comments
3. Sanitize user input before storing in expressions
4. Review security errors carefully

### Performance Issues

1. Reduce number of nodes (break into sub-workflows)
2. Reduce workflow depth (use flow_merge for parallel paths)
3. Cache validation results if running frequently
4. Use async validation for large workflows

## Future Enhancements

- [ ] Custom validation rules per module/community
- [ ] Async validation for large workflows
- [ ] Validation result caching
- [ ] Type inference for automatic type checking
- [ ] Performance profiling
- [ ] Visual workflow validation feedback
- [ ] Custom security rule definitions
- [ ] Workflow optimization suggestions
