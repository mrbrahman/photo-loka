-- Geo stage split: the single 'geo-lookup' stage becomes a five-queue chain
--   geo-cache -> geo-lookup-addr -> geo-city-cache -> geo-lookup-city
-- (local DB cache; geonames address API; local postal-code cache; geonames
-- postal API). This rewrites the persisted pipelineConfig blob so existing
-- installs match the new fixed stage set that internal/pipeline/config.go now
-- validates (strictly: every stage must appear exactly once). User
-- customizations to other stages (concurrency, gatedBy, enable) are preserved.
--
-- Two transforms on the single 'pipelineConfig' row:
--   1. Rename the stage: replace the quoted token "geo-lookup" with
--      "geo-cache" wherever it appears (the stage's own name and any gatedBy
--      reference a user may have added). The surrounding quotes make this an
--      exact-token replace, so it cannot corrupt the new "geo-lookup-addr" /
--      "geo-lookup-city" names (which are inserted in step 2, after this runs).
--   2. Append the three new local/API stages (concurrency 1, enabled) to the
--      stages array via json_insert at the end ('$.stages[#]'):
--      geo-lookup-addr, geo-city-cache, geo-lookup-city.
--
-- Guarded by WHERE so it only touches the row when it exists and still carries
-- the old 'geo-lookup' name (idempotent: a config already migrated, or one
-- that somehow lacks the stage, is left untouched).

UPDATE runtime_config
SET value = replace(value, '"geo-lookup"', '"geo-cache"')
WHERE key = 'pipelineConfig'
  AND value LIKE '%"geo-lookup"%';

UPDATE runtime_config
SET value = json_insert(
      json_insert(
        json_insert(
          value,
          '$.stages[#]', json('{"name":"geo-lookup-addr","concurrency":1,"enabled":true}')
        ),
        '$.stages[#]', json('{"name":"geo-city-cache","concurrency":1,"enabled":true}')
      ),
      '$.stages[#]', json('{"name":"geo-lookup-city","concurrency":1,"enabled":true}')
    )
WHERE key = 'pipelineConfig'
  AND value LIKE '%"geo-cache"%'
  AND value NOT LIKE '%"geo-lookup-addr"%';
