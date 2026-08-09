# Fleet Operations / DriverAttention slice

Selected `migration_b4fdd0f46a4b6413` (1/1 write). The monitoring PATCH route is a single state transition with explicit 400/404/409/200 semantics. `UpdateDriverStateCommand.v1` is declared by Fleet Operations. An exact Operations → `fleet_operations.public` amendment is required and proven acyclic. No provider, credential, schema, queue, or runtime mutation. Rollback: `06fd246ba4d732f0b7c4f8d72a8404a958404483`.
