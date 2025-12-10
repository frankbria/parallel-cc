
        BEGIN TRANSACTION;
        UPDATE schema_metadata SET value = '1.0.0-test' WHERE key = 'version';
        COMMIT;
      