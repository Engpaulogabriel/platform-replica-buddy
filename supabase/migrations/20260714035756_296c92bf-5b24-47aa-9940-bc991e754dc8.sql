
UPDATE agent_releases SET is_latest = false WHERE is_latest = true;
INSERT INTO agent_releases (version, storage_path, file_hash, file_size_bytes, artifact_type, is_latest, mandatory, release_notes, published_at)
VALUES ('3.21.1', '3.21.1/app.asar', '5c99eb6f757b7e1a63af97e0675f55b3837bd6bb95847bd13e8b88d6fefbd5d8', 11112174, 'asar', true, true,
'Republicação ofuscada da v3.21.0 (safety bit-inverso restaurado). v3.21.0 saiu sem ofuscação e falhava no startup em alguns PCs; 3.21.1 recompila com javascript-obfuscator + node --check antes do pack.',
now());
