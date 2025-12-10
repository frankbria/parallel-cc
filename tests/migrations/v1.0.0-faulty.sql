
        BEGIN TRANSACTION;
        -- This migration doesn't update schema_metadata.version
        CREATE TABLE IF NOT EXISTS test_table (id TEXT);
        COMMIT;
      