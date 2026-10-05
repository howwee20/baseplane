-- Preserve incompatible historical records for private backup/recovery, outside active lists and exports.
UPDATE documents SET type='legacy-visit',summary='{}' WHERE type='visit' AND
 (substr(key,1,6)<>'visit:' OR length(substr(key,7)) NOT BETWEEN 1 AND 100 OR substr(key,7) GLOB '*[^a-zA-Z0-9-]*');
