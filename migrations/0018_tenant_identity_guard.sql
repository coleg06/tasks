-- A database belongs to one deployment tenant for its lifetime. Ordinary DML
-- cannot relabel foreign records as this tenant or erase the binding check.
-- A deliberate identity change requires a reviewed forward migration that drops
-- and recreates these triggers. No application records or existing seeds change.
CREATE TRIGGER tenant_configuration_no_update
BEFORE UPDATE ON tenant_configuration
BEGIN
  SELECT RAISE(ABORT, 'tenant identity is immutable');
END;

CREATE TRIGGER tenant_configuration_no_delete
BEFORE DELETE ON tenant_configuration
BEGIN
  SELECT RAISE(ABORT, 'tenant identity is immutable');
END;

-- INSERT OR REPLACE may skip DELETE triggers in SQLite. Guard inserts too.
CREATE TRIGGER tenant_configuration_no_replace
BEFORE INSERT ON tenant_configuration
WHEN EXISTS (SELECT 1 FROM tenant_configuration)
BEGIN
  SELECT RAISE(ABORT, 'tenant identity is immutable');
END;
